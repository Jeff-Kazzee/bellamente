import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { searchRoutes } from "../src/search";
import { inspectRoutes } from "../src/inspect";
import { proxyRoutes } from "../src/proxy";
import { ORG_ID, DEFAULT_CONTAINER_TAG } from "../src/util";

const memId = "m".repeat(22);
const spaceId = "s".repeat(22);
const userVector = "[1,0,0,0]";

async function makeCtx() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  const embed = async ({ values }: { values: string[] }) => values.map(() => [1, 0, 0, 0]);
  await seedMemory(sql);
  return { sql, embed, close: () => sql.end() };
}

async function seedMemory(sql: Sql) {
  await sql`
    INSERT INTO space (id, container_tag, org_id)
    VALUES (${spaceId}, ${DEFAULT_CONTAINER_TAG}, ${ORG_ID})
    ON CONFLICT (container_tag, org_id) DO NOTHING`;
  await sql`
    INSERT INTO memory_entry
      (id, org_id, space_id, memory, is_latest, version, root_memory_id, memory_embedding, memory_embedding_model)
    VALUES
      (${memId}, ${ORG_ID}, ${spaceId}, ${"John prefers dark mode"}, true, 1, ${memId}, ${userVector}::vector, ${"test-embed"})`;
}

test("POST /search records an inspectable recall trace", async () => {
  const ctx = await makeCtx();
  try {
    const app = new Hono();
    app.route("/search", searchRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "which theme", limit: 1 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const traceId = res.headers.get("x-eunoia-trace-id");
    expect(traceId).toBeTruthy();
    expect(body.traceId).toBe(traceId);
    expect(res.headers.get("x-eunoia-search-results")).toBe("1");
    expect(body.results[0].id).toBe(memId);

    const inspect = await app.request(`/inspect/${traceId}`);
    expect(inspect.status).toBe(200);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ id: traceId, kind: "search", status: "ok", query: "which theme", resultCount: 1, containerTag: null });
    expect(trace.retrieved[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.retrieved[0].similarity).toBeGreaterThan(0.99);

    const list = await app.request("/inspect?limit=not-a-number");
    expect(list.status).toBe(200);
    const { traces } = await list.json();
    expect(traces.some((t: any) => t.id === traceId)).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("proxy injection emits trace headers and stores injected context", async () => {
  const ctx = await makeCtx();
  try {
    await ctx.sql`
      UPDATE space SET metadata = ${ctx.sql.json({ profile: { static: ["John prefers concise answers"], dynamic: [] } })}
      WHERE id = ${spaceId}`;

    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eunoia-user-id": "external-user-1" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-eunoia-context-modified")).toBe("true");
    expect(res.headers.get("x-eunoia-tool-intercept")).toBe("searchMemory");
    const body = await res.json();
    const traceId = body.traceId;
    expect(res.headers.get("x-eunoia-trace-id")).toBe(traceId);

    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "context_injected", userId: "external-user-1" });
    expect(trace.query).toContain("Help me choose a theme");
    expect(trace.injected.map((i: any) => i.type)).toEqual(["tool", "profile"]);
    expect(trace.injected[1].content).toContain("John prefers concise answers");
  } finally {
    await ctx.close();
  }
});
