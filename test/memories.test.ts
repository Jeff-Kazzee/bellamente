// memories.test.ts - the memory lifecycle: dedup/supersede on write, versioned edits, forget/undo,
// hard delete, and the version-chain read. Runs the real routes against PGlite with a content-keyed
// fake embedder (4-d vectors chosen for exact cosine similarities).
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { memoriesRoutes, sweepExpiredMemories, writeMemory } from "../src/memories";
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

test("exact duplicate WITH new flags applies them to the existing row (action 'updated')", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const first = await (await post(app, "/memories", { memories: [{ content: "John prefers dark mode" }] })).json();
    const id = first.memories[0].id;

    // The natural "refresh this fact's expiry" pattern used to be silently dropped while the
    // response echoed the new forgetAfter as if it stuck.
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await (await post(app, "/memories", {
      memories: [{ content: "John prefers dark mode", forgetAfter: future, forgetReason: "short-lived" }],
    })).json();
    expect(res.memories[0]).toMatchObject({ action: "updated", id, version: 1 });
    const [row] = await sql`SELECT forget_after, forget_reason FROM memory_entry WHERE id = ${id}`;
    expect(row!.forget_after).not.toBeNull();
    expect(row!.forget_reason).toBe("short-lived");
    expect(await countRows(sql)).toBe(1); // still no new row

    // A bare resubmit (no flags) stays "unchanged" and touches nothing.
    const bare = await (await post(app, "/memories", { memories: [{ content: "John prefers dark mode" }] })).json();
    expect(bare.memories[0].action).toBe("unchanged");
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("memories over the embed token budget are flagged embedTruncated in the response", async () => {
  const { app, close } = await makeApp();
  try {
    const long = "한".repeat(600); // ~600 tokens > 480 budget; embedded whole, tail truncated by the model
    const res = await (await post(app, "/memories", { memories: [{ content: long }, { content: "John lives in Denver" }] })).json();
    expect(res.memories[0].embedTruncated).toBe(true);
    expect(res.memories[1].embedTruncated).toBeUndefined();
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("POST supersedes a near-duplicate: new version, old flipped is_latest=false, chain readable", async () => {
  process.env.BELLA_SUPERSEDE_THRESHOLD = "0.9";
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
    const [newRow] = await sql`SELECT is_latest, version, parent_memory_id, root_memory_id, source_count FROM memory_entry WHERE id = ${newId}`;
    expect(newRow).toMatchObject({ is_latest: true, parent_memory_id: oldId, root_memory_id: oldId });
    expect(Number(newRow!.version)).toBe(2);
    expect(Number(newRow!.source_count)).toBe(2); // re-observation reinforces the fact

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
    delete process.env.BELLA_SUPERSEDE_THRESHOLD;
    await close();
  }
}, TEST_TIMEOUT_MS);

// --- SPEC-P1.8: temporal validity — both flip sites stamp windows inside their transaction ---

test("supersede stamps validity windows transactionally: old.valid_to === new.valid_from EXACTLY (P1.8 B2)", async () => {
  process.env.BELLA_SUPERSEDE_THRESHOLD = "0.9";
  const { app, sql, close } = await makeApp();
  try {
    const first = await (await post(app, "/memories", { memories: [{ content: "John prefers dark mode" }] })).json();
    const v1Id = first.memories[0].id;
    // A freshly created memory has an OPEN window: NULL = "valid since creation".
    const [created] = await sql`SELECT valid_from, valid_to FROM memory_entry WHERE id = ${v1Id}`;
    expect(created!.valid_from).toBeNull();
    expect(created!.valid_to).toBeNull();

    const second = await (await post(app, "/memories", { memories: [{ content: "John prefers light mode" }] })).json();
    expect(second.memories[0].action).toBe("superseded");
    const v2Id = second.memories[0].id;

    const [oldRow] = await sql`SELECT valid_from, valid_to FROM memory_entry WHERE id = ${v1Id}`;
    const [newRow] = await sql`SELECT valid_from, valid_to FROM memory_entry WHERE id = ${v2Id}`;
    expect(oldRow!.valid_to).not.toBeNull();
    expect(newRow!.valid_from).not.toBeNull();
    expect(newRow!.valid_to).toBeNull();
    // now() is transaction-frozen: the INSERT and the flip UPDATE run in ONE tx, so the boundary
    // is gapless and overlap-free BY CONSTRUCTION — this equality is the acceptance for it.
    expect(new Date(oldRow!.valid_to).toISOString()).toBe(new Date(newRow!.valid_from).toISOString());
    // SQL-level equality at FULL microsecond precision: separate-tx now() pairs collide at JS ms
    // precision ~9% of the time (review measured 18/200), which would let a stamp-outside-the-tx
    // mutation survive probabilistically. Postgres compares its own precision — deterministic kill.
    const [eq] = await sql`SELECT (SELECT valid_to FROM memory_entry WHERE id = ${v1Id}) = (SELECT valid_from FROM memory_entry WHERE id = ${v2Id}) AS eq`;
    expect(eq!.eq).toBe(true);

    // GET /:id exposes the windows on EVERY chain row (ISO or null) — B3's read surface.
    const chain = await (await app.request(`/memories/${v1Id}`)).json();
    expect(chain.versions).toHaveLength(2);
    expect(chain.versions[0].validFrom).toBeNull();
    expect(chain.versions[0].validTo).toBe(new Date(oldRow!.valid_to).toISOString());
    expect(chain.versions[1].validFrom).toBe(new Date(newRow!.valid_from).toISOString());
    expect(chain.versions[1].validTo).toBeNull();
  } finally {
    delete process.env.BELLA_SUPERSEDE_THRESHOLD;
    await close();
  }
}, TEST_TIMEOUT_MS);

test("PATCH content edit stamps windows the same way as supersede (P1.8 B2, second flip site)", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const created = await (await post(app, "/memories", { memories: [{ content: "John lives in Denver" }] })).json();
    const id = created.memories[0].id;
    const edited = await (await patch(app, `/memories/${id}`, { content: "John lives in Boulder now" })).json();
    expect(edited.action).toBe("versioned");
    const newVersionId = edited.memory.id;

    const [oldRow] = await sql`SELECT valid_from, valid_to FROM memory_entry WHERE id = ${id}`;
    const [newRow] = await sql`SELECT valid_from, valid_to FROM memory_entry WHERE id = ${newVersionId}`;
    expect(oldRow!.valid_to).not.toBeNull();
    expect(newRow!.valid_from).not.toBeNull();
    expect(new Date(oldRow!.valid_to).toISOString()).toBe(new Date(newRow!.valid_from).toISOString());
    // Full-precision SQL equality — same rationale as the supersede-site test above.
    const [eq] = await sql`SELECT (SELECT valid_to FROM memory_entry WHERE id = ${id}) = (SELECT valid_from FROM memory_entry WHERE id = ${newVersionId}) AS eq`;
    expect(eq!.eq).toBe(true);
    // The PATCH response body carries the window too (normalizeMemory).
    expect(edited.memory.validFrom).toBe(new Date(newRow!.valid_from).toISOString());
    expect(edited.memory.validTo).toBeNull();
  } finally {
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

    // Un-forgetting an auto-expired memory clears forget_after — otherwise the NEXT sweep cycle
    // would silently re-forget it within the hour, undoing the user's restore.
    const [expiredRow] = await sql`SELECT id FROM memory_entry WHERE memory = ${"John lives in Denver"}`;
    const undo = await (await post(app, `/memories/${expiredRow!.id}/forget`, { undo: true })).json();
    expect(undo).toMatchObject({ forgotten: false });
    const [restored] = await sql`SELECT is_forgotten, forget_after FROM memory_entry WHERE id = ${expiredRow!.id}`;
    expect(restored).toMatchObject({ is_forgotten: false, forget_after: null });
    expect(await sweepExpiredMemories(sql)).toBe(0); // the sweep no longer re-forgets it
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
// #128: PATCH read is_latest on the plain connection, embedded in the async gap, then INSERTed the
// new version unconditionally — two concurrent edits both passed the check and left TWO permanent
// is_latest=true rows in one chain (both surfacing as current in list/search). The invariant below
// is what the fix (flip-first guard inside the tx + the one-latest-per-chain index) makes impossible.
test("concurrent content PATCHes cannot leave two latest versions in one chain (#128)", async () => {
  const { app, sql, close } = await makeApp();
  try {
    const created = await (await post(app, "/memories", { memories: [{ content: "John lives in Denver" }] })).json();
    const id = created.memories[0].id;

    const [a, b] = await Promise.all([
      patch(app, `/memories/${id}`, { content: "John lives in Boulder now" }),
      patch(app, `/memories/${id}`, { content: "John prefers light mode" }),
    ]);

    // Exactly one edit wins; the loser is told to re-read (409 + pointer at the new latest).
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const loserBody = await loser.json();
    expect(loserBody.latestId).toBeTruthy();
    // Pin the GUARD path (the flip returned 0 rows), not just "some 409": the lost-race message proves the
    // new flip-first guard is what fired, so a refactor that stopped exercising it would fail here (#128).
    expect(loserBody.error).toMatch(/modified concurrently/);

    // The invariant #128 broke: one latest row per chain, no matter how the race lands.
    const latest = await sql`
      SELECT id FROM memory_entry
      WHERE (root_memory_id = ${id} OR id = ${id}) AND is_latest = true`;
    expect(latest.length).toBe(1);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("the one-latest-per-chain index rejects a duplicate latest row at the DB layer (#128 backstop)", async () => {
  const { sql, close } = await makeApp();
  try {
    const rootId = "a".repeat(22), dupId = "b".repeat(22), spaceId = "s".repeat(22);
    await sql`INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, version, root_memory_id)
              VALUES (${rootId}, ${ORG_ID}, ${spaceId}, 'fact v1', true, 1, ${rootId})`;
    await expect(
      (async () => {
        await sql`INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, version, root_memory_id, parent_memory_id)
                  VALUES (${dupId}, ${ORG_ID}, ${spaceId}, 'fact v2', true, 2, ${rootId}, ${rootId})`;
      })()
    ).rejects.toThrow(/one_latest|duplicate key/i);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

// #128 Q4.1: a batch write's supersede can lose a version race ONLY on external pooled Postgres (PGlite
// serializes whole transactions, so the in-tx `nearest` read can't go stale). The merged fix THREW there,
// which aborts the ENTIRE batch tx — one racy item would 500 every other item in the request. It now
// returns a per-item `conflict` instead. A fake tagged-template `tx` reaches that otherwise-unreachable
// path deterministically (route by SQL shape; the flip UPDATE returns [] to force the lost race).
function fakeTx(flipRows: unknown[], onInsert: () => void) {
  const tx: any = (strings: TemplateStringsArray) => {
    const q = strings.join(" ? ");
    if (/md5\(memory\)/.test(q)) return Promise.resolve([]); // no exact dup
    if (/ORDER BY memory_embedding/.test(q)) {
      return Promise.resolve([{ id: "n".repeat(22), version: 3, root_memory_id: null, source_count: 2, similarity: 0.999 }]);
    }
    if (/SET is_latest = false/.test(q)) return Promise.resolve(flipRows); // [] = lost race, [{id}] = won
    if (/INSERT INTO memory_entry/.test(q)) { onInsert(); return Promise.resolve([]); }
    return Promise.resolve([]);
  };
  tx.json = (x: unknown) => x;
  return tx;
}

const CONFLICT_ARGS = {
  spaceId: "s".repeat(22), content: "John lives in Boulder now", isStatic: false, isInference: false,
  metadata: null, forgetAfter: null, forgetReason: null, embedding: [0.9, 0.312, 0, 0], model: "test",
  dedupe: true, provided: { isStatic: false, metadata: false, forgetAfter: false, forgetReason: false },
};

test("writeMemory: a LOST supersede race returns a per-item `conflict` — never throws, never inserts (#128 Q4.1)", async () => {
  let inserted = false;
  const r = await writeMemory(fakeTx([], () => { inserted = true; }), { ...CONFLICT_ARGS });
  expect(r.action).toBe("conflict");
  expect(r.id).toBe("n".repeat(22)); // points the caller at the contested chain to re-read
  expect(inserted).toBe(false); // no INSERT on a lost race -> batch tx stays clean, other items commit
});

test("writeMemory: a WON supersede race still inserts the new version (positive control) (#128 Q4.1)", async () => {
  let inserted = false;
  const r = await writeMemory(fakeTx([{ id: "n".repeat(22) }], () => { inserted = true; }), { ...CONFLICT_ARGS });
  expect(r.action).toBe("superseded");
  expect(r.supersededId).toBe("n".repeat(22));
  expect(inserted).toBe(true);
});
