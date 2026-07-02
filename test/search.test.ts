// search.test.ts - fusion correctness for searchChunks (threshold on the vector leg) and
// top-level hybrid mode (rank-based RRF instead of raw-score sorting across incompatible scales).
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { search, searchChunks, searchRoutes, Q } from "../src/search";
import { ORG_ID, DEFAULT_CONTAINER_TAG } from "../src/util";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 15000;
const spaceId = "s".repeat(22);
const docId = "d".repeat(22);
const chunkVecId = "a".repeat(22); // vector hit: embedding matches the query
const chunkKwId = "b".repeat(22); // keyword hit: embedding orthogonal to the query
const memIds = ["m1".padEnd(22, "x"), "m2".padEnd(22, "x"), "m3".padEnd(22, "x")];

// Every query embeds to [1,0,0,0]; row vectors are chosen for exact cosine similarities against it.
const queryEmbed: Embed = async ({ values }) => values.map(() => [1, 0, 0, 0]);

async function makeCtx() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  await seed(sql);
  return { sql, embed: queryEmbed, close: () => sql.end() };
}

async function seed(sql: Sql) {
  await sql`
    INSERT INTO space (id, container_tag, org_id)
    VALUES (${spaceId}, ${DEFAULT_CONTAINER_TAG}, ${ORG_ID})
    ON CONFLICT (container_tag, org_id) DO NOTHING`;
  await sql`
    INSERT INTO document (id, content, type, source, status, task_type, container_tags, title, org_id)
    VALUES (${docId}, ${"doc"}, 'text', 'file', 'done', 'superrag', ${[DEFAULT_CONTAINER_TAG]}, ${"Doc"}, ${ORG_ID})`;
  // similarity vs query: chunkVec = 1.0 (passes any threshold), chunkKw = 0.0 (fails every threshold).
  await sql`
    INSERT INTO chunk (id, document_id, content, position, embedding, embedding_model)
    VALUES (${chunkVecId}, ${docId}, ${"alpha preferences settings"}, 0, ${"[1,0,0,0]"}::vector, ${"test-embed"}),
           (${chunkKwId}, ${docId}, ${"the zebra keyword target phrase"}, 1, ${"[0,1,0,0]"}::vector, ${"test-embed"})`;
  // memory similarities vs query: 1.0, 0.8, 0.55 — all above the 0.5 test threshold.
  const memVectors = ["[1,0,0,0]", "[0.8,0.6,0,0]", "[0.55,0.8352,0,0]"];
  for (let i = 0; i < memIds.length; i++) {
    await sql`
      INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, version, root_memory_id, memory_embedding, memory_embedding_model)
      VALUES (${memIds[i]}, ${ORG_ID}, ${spaceId}, ${"memory " + (i + 1)}, true, 1, ${memIds[i]}, ${memVectors[i]}::vector, ${"test-embed"})`;
  }
}

test("searchChunks applies the cosine floor to the vector leg on the default keyword path", async () => {
  const ctx = await makeCtx();
  try {
    const results = await searchChunks(ctx as any, { q: "zebra", threshold: 0.5, limit: 10 });
    const kw = results.find((r) => r.id === chunkKwId);
    const vec = results.find((r) => r.id === chunkVecId);
    // The keyword hit survives on text-match evidence, but ONLY via the keyword leg — its 0.0 cosine
    // similarity must no longer sneak through the vector leg (pre-fix it fused as source "both").
    expect(kw).toBeDefined();
    expect(kw!.source).toBe("keyword");
    expect(vec).toBeDefined();
    expect(vec!.source).toBe("vector");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("searchChunks keyword=false still enforces the threshold (no keyword rescue)", async () => {
  const ctx = await makeCtx();
  try {
    const results = await searchChunks(ctx as any, { q: "zebra", threshold: 0.5, limit: 10, keyword: false });
    expect(results.some((r) => r.id === chunkKwId)).toBe(false);
    expect(results.some((r) => r.id === chunkVecId)).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("POST /search: missing q is a 400; an embed failure re-throws (500) after recording an error trace", async () => {
  const ctx = await makeCtx();
  try {
    const failingEmbed: Embed = async () => {
      throw new Error("embedder offline");
    };
    const app = new Hono();
    app.route("/search", searchRoutes({ sql: ctx.sql, embed: failingEmbed }));

    const bad = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("q (string) is required");

    // An unparseable body degrades to {} (the catch), which then fails the same q guard.
    const unparseable = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(unparseable.status).toBe(400);

    const res = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "zebra", containerTag: DEFAULT_CONTAINER_TAG }),
    });
    // The route records the error trace, sets the trace header, then RE-THROWS — Hono's default
    // error handler turns that into a 500.
    expect(res.status).toBe(500);

    const [trace] = await ctx.sql`
      SELECT id, status, query, queries, search_mode, container_tag, result_count, metadata
      FROM recall_trace WHERE kind = 'search' AND status = 'error'`;
    expect(trace).toBeDefined();
    expect(trace!.query).toBe("zebra");
    expect(trace!.queries).toEqual(["zebra"]);
    expect(trace!.search_mode).toBe("memories"); // the default mode is recorded even on failure
    expect(trace!.container_tag).toBe(DEFAULT_CONTAINER_TAG);
    expect(Number(trace!.result_count)).toBe(0);
    expect(trace!.metadata?.error).toBe("embedder offline");
    // The trace id header still points at the recorded error trace, so the failure is inspectable.
    expect(res.headers.get("x-bella-trace-id")).toBe(trace!.id);
    // The 400 path records no trace; only the one error trace exists.
    const n = await ctx.sql`SELECT count(*)::int AS n FROM recall_trace WHERE kind = 'search'`;
    expect(Number(n[0]!.n)).toBe(1);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("POST /search: a slow search resolves EMPTY at the deadline with a 200 and a 'timeout' trace", async () => {
  const ctx = await makeCtx();
  const originalTimeout = Q.SEARCH_TIMEOUT_MS; // read per request, so tunable without env plumbing
  try {
    Q.SEARCH_TIMEOUT_MS = 25;
    const slowEmbed: Embed = async ({ values }) => {
      await new Promise((r) => setTimeout(r, 250));
      return values.map(() => [1, 0, 0, 0]);
    };
    const app = new Hono();
    app.route("/search", searchRoutes({ sql: ctx.sql, embed: slowEmbed }));

    const res = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "zebra" }),
    });
    // The deadline degrades to an empty result set — NOT an error — and says so in the trace.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(res.headers.get("x-bella-search-results")).toBe("0");

    const [trace] = await ctx.sql`SELECT id, status, result_count FROM recall_trace WHERE kind = 'search'`;
    expect(trace).toBeDefined();
    expect(trace!.status).toBe("timeout");
    expect(Number(trace!.result_count)).toBe(0);
    expect(res.headers.get("x-bella-trace-id")).toBe(trace!.id);

    // Let the abandoned slow search drain before closing the DB under it.
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    Q.SEARCH_TIMEOUT_MS = originalTimeout;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("hybrid mode ranks keyword-only chunks by RRF rank, not raw similarity", async () => {
  const ctx = await makeCtx();
  try {
    const results = await search(ctx as any, { q: "zebra", threshold: 0.5, limit: 10, searchMode: "hybrid" });
    const kwIndex = results.findIndex((r) => r.type === "chunk" && r.id === chunkKwId);
    const mem3Index = results.findIndex((r) => r.type === "memory" && r.id === memIds[2]);
    expect(kwIndex).toBeGreaterThanOrEqual(0);
    expect(mem3Index).toBeGreaterThanOrEqual(0);
    // Pre-fix, similarity-0 keyword hits sorted strictly LAST. With rank fusion, the chunk list's #2
    // (the keyword hit) outranks the memory list's #3 — same rank position, earlier list insertion.
    expect(kwIndex).toBeLessThan(mem3Index);
    expect(results.length).toBe(5);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
