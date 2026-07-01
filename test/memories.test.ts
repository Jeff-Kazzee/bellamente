// memories.test.ts - the memory lifecycle: dedup/supersede on write, versioned edits, forget/undo,
// hard delete, and the version-chain read. Runs the real routes against PGlite with a content-keyed
// fake embedder (4-d vectors chosen for exact cosine similarities).
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { memoriesRoutes, sweepExpiredMemories } from "../src/memories";
import { ORG_ID } from "../src/util";
import { EMBED_DIM } from "../src/embed-common";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 20000;

// The write path validates vectors against the module-level EMBED_DIM (env/machine-resolved at import),
// so fixture vectors are 4-d shapes ZERO-PADDED to the real dim — cosine similarities are unchanged.
const pad = (v: number[]): number[] => [...v, ...new Array(Math.max(EMBED_DIM - v.length, 0)).fill(0)];

// Content-keyed vectors: dark/light mode are near-duplicates (cosine ~0.95); everything else is
// orthogonal to them (cosine 0).
const VECTORS: Record<string, number[]> = {
  "John prefers dark mode": pad([1, 0, 0, 0]),
  "John prefers light mode": pad([0.95, 0.312, 0, 0]),
  "John lives in Denver": pad([0, 1, 0, 0]),
  "John lives in Boulder now": pad([0, 0, 1, 0]),
};
const contentEmbed: Embed = async ({ values }) => values.map((v) => VECTORS[v] ?? pad([0, 0, 0, 1]));

async function makeApp() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  const app = new Hono();
  app.route("/memories", memoriesRoutes({ sql, embed: contentEmbed }));
  return { app, sql, close: () => sql.end() };
}

async function post(app: Hono, path: string, body: unknown) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function patch(app: Hono, path: string, body: unknown) {
  return app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function countRows(sql: Sql): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM memory_entry WHERE org_id = ${ORG_ID}`;
  return Number(rows[0]!.n);
}

test("POST creates memories with provenance; exact resubmission is 'unchanged' (no new rows)", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const res = await post(app, "/memories", {
      memories: [{ content: "John prefers dark mode", isStatic: true }, { content: "John lives in Denver" }],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.documentId).toBeTruthy();
    expect(body.memories.map((m: any) => m.action)).toEqual(["created", "created"]);
    expect(body.memories.map((m: any) => m.version)).toEqual([1, 1]);
    expect(await countRows(sql)).toBe(2);
    const links = await sql`SELECT count(*)::int AS n FROM memory_document_source`;
    expect(Number(links[0]!.n)).toBe(2);

    // Exact duplicate -> unchanged, same id, still 2 rows, no grouping document created.
    const dup = await post(app, "/memories", { memories: [{ content: "John prefers dark mode" }] });
    const dupBody = await dup.json();
    expect(dupBody.memories[0]).toMatchObject({ action: "unchanged", id: body.memories[0].id, version: 1 });
    expect(dupBody.documentId).toBeNull();
    expect(await countRows(sql)).toBe(2);

    // In-batch dedupe: two identical contents in ONE request -> created + unchanged.
    const batch = await post(app, "/memories", {
      memories: [{ content: "John lives in Boulder now" }, { content: "John lives in Boulder now" }],
    });
    const batchBody = await batch.json();
    expect(batchBody.memories.map((m: any) => m.action)).toEqual(["created", "unchanged"]);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("POST supersedes a near-duplicate: new version, old flipped is_latest=false, chain readable", async () => {
  process.env.EUNOIA_SUPERSEDE_THRESHOLD = "0.9";
  const { app, sql, close } = await makeApp();
  try {
    const first = await (await post(app, "/memories", { memories: [{ content: "John prefers dark mode" }] })).json();
    const oldId = first.memories[0].id;

    const res = await post(app, "/memories", { memories: [{ content: "John prefers light mode" }] });
    const body = await res.json();
    expect(body.memories[0]).toMatchObject({ action: "superseded", version: 2, supersededId: oldId });
    const newId = body.memories[0].id;

    const [oldRow] = await sql`SELECT is_latest, version FROM memory_entry WHERE id = ${oldId}`;
    expect(oldRow).toMatchObject({ is_latest: false });
    const [newRow] = await sql`SELECT is_latest, version, parent_memory_id, root_memory_id FROM memory_entry WHERE id = ${newId}`;
    expect(newRow).toMatchObject({ is_latest: true, parent_memory_id: oldId, root_memory_id: oldId });
    expect(Number(newRow!.version)).toBe(2);

    // The chain is readable from EITHER id and shows both versions in order.
    const chain = await (await app.request(`/memories/${oldId}`)).json();
    expect(chain.versions.map((v: any) => v.version)).toEqual([1, 2]);
    expect(chain.versions[1].memory).toBe("John prefers light mode");

    // GET list shows only the latest version.
    const list = await (await app.request("/memories")).json();
    const texts = list.memories.map((m: any) => m.memory);
    expect(texts).toContain("John prefers light mode");
    expect(texts).not.toContain("John prefers dark mode");

    // dedupe:false bypasses both checks (bulk import path).
    const raw = await (await post(app, "/memories", { dedupe: false, memories: [{ content: "John prefers light mode" }] })).json();
    expect(raw.memories[0].action).toBe("created");
  } finally {
    delete process.env.EUNOIA_SUPERSEDE_THRESHOLD;
    await close();
  }
}, TEST_TIMEOUT_MS);

test("PATCH: content change writes a new version; flag change edits in place; stale version 409s", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const created = await (await post(app, "/memories", { memories: [{ content: "John lives in Denver" }] })).json();
    const id = created.memories[0].id;

    // Content edit -> versioned.
    const edited = await (await patch(app, `/memories/${id}`, { content: "John lives in Boulder now" })).json();
    expect(edited.action).toBe("versioned");
    expect(edited.supersededId).toBe(id);
    expect(edited.memory).toMatchObject({ version: 2, isLatest: true, memory: "John lives in Boulder now", parentMemoryId: id });
    const newVersionId = edited.memory.id;
    const [oldRow] = await sql`SELECT is_latest FROM memory_entry WHERE id = ${id}`;
    expect(oldRow!.is_latest).toBe(false);

    // Flag-only edit -> in place, no new version.
    const flagged = await (await patch(app, `/memories/${newVersionId}`, { isStatic: true, metadata: { pinned: true } })).json();
    expect(flagged.action).toBe("updated");
    expect(flagged.memory).toMatchObject({ version: 2, isStatic: true });
    expect(await sql`SELECT count(*)::int AS n FROM memory_entry`.then((r) => Number(r[0]!.n))).toBe(2);

    // Editing a superseded version is refused with a pointer to the latest.
    const stale = await patch(app, `/memories/${id}`, { content: "should not land" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).latestId).toBe(newVersionId);

    // Guardrails.
    expect((await patch(app, `/memories/${newVersionId}`, {})).status).toBe(400);
    expect((await patch(app, "/memories/not-a-valid-id!!", { content: "x" })).status).toBe(400);
    expect((await patch(app, `/memories/${"z".repeat(22)}`, { content: "x" })).status).toBe(404);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("forget_after sweep durably forgets expired memories, leaves live ones alone", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await post(app, "/memories", {
      memories: [
        { content: "John lives in Denver", forgetAfter: past, forgetReason: "temp note" },
        { content: "John prefers dark mode", forgetAfter: future },
      ],
    });
    const swept = await sweepExpiredMemories(sql);
    expect(swept).toBe(1);
    const rows = await sql`SELECT memory, is_forgotten, forget_reason FROM memory_entry ORDER BY memory`;
    const expired = rows.find((r) => r.memory === "John lives in Denver");
    const live = rows.find((r) => r.memory === "John prefers dark mode");
    expect(expired).toMatchObject({ is_forgotten: true, forget_reason: "temp note" }); // existing reason kept
    expect(live).toMatchObject({ is_forgotten: false });
    expect(await sweepExpiredMemories(sql)).toBe(0); // idempotent
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("forget hides the whole chain from the list (reversibly); DELETE removes it physically", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const created = await (await post(app, "/memories", { memories: [{ content: "John lives in Denver" }] })).json();
    const id = created.memories[0].id;
    await patch(app, `/memories/${id}`, { content: "John lives in Boulder now" }); // -> a 2-version chain

    // Forget the chain (works from ANY version id in the chain).
    const forgot = await (await post(app, `/memories/${id}/forget`, { reason: "user asked" })).json();
    expect(forgot).toMatchObject({ forgotten: true, affected: 2 });
    const list = await (await app.request("/memories")).json();
    expect(list.memories).toHaveLength(0);
    // ...but still inspectable: the chain read hides nothing.
    const chain = await (await app.request(`/memories/${id}`)).json();
    expect(chain.versions.every((v: any) => v.isForgotten)).toBe(true);
    expect(chain.versions[0].forgetReason).toBe("user asked");

    // Undo restores it.
    const undo = await (await post(app, `/memories/${id}/forget`, { undo: true })).json();
    expect(undo).toMatchObject({ forgotten: false, affected: 2 });
    expect((await (await app.request("/memories")).json()).memories).toHaveLength(1);

    // Hard delete removes the chain AND its provenance links.
    const del = await app.request(`/memories/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(2);
    expect(await countRows(sql)).toBe(0);
    const links = await sql`SELECT count(*)::int AS n FROM memory_document_source`;
    expect(Number(links[0]!.n)).toBe(0);
    expect((await app.request(`/memories/${id}`)).status).toBe(404);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);
