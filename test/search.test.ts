// search.test.ts - fusion correctness for searchChunks (threshold on the vector leg) and
// top-level hybrid mode (rank-based RRF instead of raw-score sorting across incompatible scales).
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { search, searchChunks, searchMemories, searchRoutes, recencyWeight, recencyTauDays, Q } from "../src/search";
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

// --- SPEC-P1.3: full-text leg for MEMORY search (B1-B4) ---
// Fixture memories inserted per-test so the shared seed (and the exact-similarity tests above) stay
// untouched. All carry [0,1,0,0] embeddings unless noted: orthogonal to the query embedding [1,0,0,0],
// so cosine similarity is 0.0 and ONLY the keyword leg can find them.
async function insertMemory(
  sql: Sql,
  m: { id: string; memory: string; vec?: string; isLatest?: boolean; isForgotten?: boolean; space?: string; createdAt?: string },
) {
  await sql`
    INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, is_forgotten, version, root_memory_id, memory_embedding, memory_embedding_model, created_at)
    VALUES (${m.id}, ${ORG_ID}, ${m.space ?? spaceId}, ${m.memory}, ${m.isLatest ?? true}, ${m.isForgotten ?? false}, 1, ${m.id}, ${m.vec ?? "[0,1,0,0]"}::vector, ${"test-embed"}, COALESCE(${m.createdAt ?? null}::timestamp, now()))`;
}

test("searchMemories finds a rare literal token by keyword when its embedding is orthogonal to the query (B1)", async () => {
  const ctx = await makeCtx();
  try {
    const kwId = "kw".padEnd(22, "x");
    await insertMemory(ctx.sql, { id: kwId, memory: "deploy code XK-42-BETA is live" });
    const results = await searchMemories(ctx as any, { q: "XK-42-BETA", threshold: 0.5, limit: 10 });
    expect(results.some((r) => r.id === kwId)).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("keyword-only memory hits carry similarity 0 but rank via RRF without breaking the shape (B2)", async () => {
  const ctx = await makeCtx();
  try {
    const kwId = "kw".padEnd(22, "x");
    await insertMemory(ctx.sql, { id: kwId, memory: "deploy code XK-42-BETA is live" });
    const results = await searchMemories(ctx as any, { q: "XK-42-BETA", threshold: 0.5, limit: 10 });
    const hit = results.find((r) => r.id === kwId);
    expect(hit).toBeDefined();
    expect(hit!.type).toBe("memory");
    expect(hit!.memory).toContain("XK-42-BETA");
    expect(typeof hit!.version).toBe("number");
    // No cosine evidence -> similarity 0, but it must still be a NUMBER (the response shape is frozen).
    expect(hit!.similarity).toBe(0);
    for (const r of results) expect(Number.isFinite(r.similarity)).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("threshold floors the vector leg only: a sub-threshold memory stays out until keyword finds it (B3)", async () => {
  const ctx = await makeCtx();
  try {
    const subId = "sub".padEnd(22, "x");
    // cosine vs the query embedding [1,0,0,0] is exactly 0.3 — below the 0.5 floor.
    await insertMemory(ctx.sql, { id: subId, memory: "XK-42-BETA rollout checklist", vec: "[0.3,0.9539392014169457,0,0]" });
    // No keyword overlap -> the memory is vector-only, and the floor excludes it (unchanged semantics).
    const vectorOnly = await searchMemories(ctx as any, { q: "unrelated calendar shopping list", threshold: 0.5, limit: 10 });
    expect(vectorOnly.some((r) => r.id === subId)).toBe(false);
    // The SAME memory found by keyword is included: the floor never applies to the keyword leg.
    const keyword = await searchMemories(ctx as any, { q: "XK-42-BETA", threshold: 0.5, limit: 10 });
    expect(keyword.some((r) => r.id === subId)).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("searchMemories keyword=false stays pure vector: threshold enforced, no keyword rescue", async () => {
  const ctx = await makeCtx();
  try {
    const kwId = "kw".padEnd(22, "x");
    await insertMemory(ctx.sql, { id: kwId, memory: "deploy code XK-42-BETA is live" });
    const results = await searchMemories(ctx as any, { q: "XK-42-BETA", threshold: 0.5, limit: 10, keyword: false });
    expect(results.some((r) => r.id === kwId)).toBe(false); // legacy vector-only path, like chunks
    expect(results.map((r) => r.id)).toEqual(memIds); // seeded sims 1.0/0.8/0.55 in vector order
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("is_latest / is_forgotten / containerTag filters apply to the keyword leg too (B4)", async () => {
  const ctx = await makeCtx();
  try {
    const visibleId = "vis".padEnd(22, "x");
    const forgottenId = "fgt".padEnd(22, "x");
    const staleId = "old".padEnd(22, "x");
    const otherSpaceMemId = "osp".padEnd(22, "x");
    const otherSpaceId = "o".repeat(22);
    await ctx.sql`
      INSERT INTO space (id, container_tag, org_id)
      VALUES (${otherSpaceId}, ${"other-tag"}, ${ORG_ID})`;
    await insertMemory(ctx.sql, { id: visibleId, memory: "XK-42-BETA is the launch code" });
    await insertMemory(ctx.sql, { id: forgottenId, memory: "XK-42-BETA was retired", isForgotten: true });
    await insertMemory(ctx.sql, { id: staleId, memory: "XK-42-BETA superseded draft", isLatest: false });
    await insertMemory(ctx.sql, { id: otherSpaceMemId, memory: "XK-42-BETA lives elsewhere", space: otherSpaceId });
    const results = await searchMemories(ctx as any, {
      q: "XK-42-BETA",
      threshold: 0.5,
      limit: 10,
      containerTag: DEFAULT_CONTAINER_TAG,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(visibleId);
    expect(ids).not.toContain(forgottenId); // a forgotten memory with the rare token is NOT returned
    expect(ids).not.toContain(staleId);
    expect(ids).not.toContain(otherSpaceMemId);
  } finally {
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

// --- Codex review follow-ups (PR #79, verdict MERGE-WITH-FOLLOW-UPS) ---

test("RRF tie at limit:1 — the exact keyword hit survives against a tied vector row", async () => {
  const ctx = await makeCtx();
  try {
    // One memory with a HIGH-cosine embedding (same direction as the query embed [1,0,0,0]) and one
    // keyword-only exact-token memory (orthogonal embedding). Both rank #1 in their leg -> equal RRF
    // score 1/(K+1). The literal token match is stronger evidence for a token query: it must win the
    // tie instead of losing to Map insertion order and being sliced off at limit:1.
    const vecId = "tievec".padEnd(22, "x");
    const kwId = "tiekw".padEnd(22, "x");
    await insertMemory(ctx.sql, { id: vecId, memory: "deployment processes are documented", vec: "[1,0,0,0]" });
    await insertMemory(ctx.sql, { id: kwId, memory: "deploy code XK-42-BETA is live" });
    const results = await searchMemories(ctx as any, { q: "XK-42-BETA", threshold: 0.5, limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(kwId);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("keyword leg respects forget_after expiry (B4 strengthened)", async () => {
  const ctx = await makeCtx();
  try {
    const expiredId = "kwexpired".padEnd(22, "x");
    await insertMemory(ctx.sql, { id: expiredId, memory: "legacy code XK-42-BETA retired" });
    await ctx.sql`UPDATE memory_entry SET forget_after = now() - interval '1 hour' WHERE id = ${expiredId}`;
    const results = await searchMemories(ctx as any, { q: "XK-42-BETA", threshold: 0.5, limit: 10 });
    // expired-but-unswept memories must not leak through the keyword leg
    expect(results.some((r) => r.id === expiredId)).toBe(false);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("a query that parses to an empty tsquery degrades to vector-only, never throws", async () => {
  const ctx = await makeCtx();
  try {
    const results = await searchMemories(ctx as any, { q: "&&& |||", threshold: 0, limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

// --- SPEC P1.2 (issue #36): recency/time-decay ranking (B1-B4) ---
// Fixtures avoid the query's tokens in memory text so the keyword leg stays empty and only
// vector rank + recency decay determine ordering. Query embeds to [1,0,0,0] (fake embed).

// Isolated space: the shared seed's m1 (sim 1.0, created now) would win any mixed-fixture race.
const REC_SPACE = "recspace".padEnd(22, "x");
const REC_TAG = "recency_test";
const OLD_EXACT = { id: "reca-old".padEnd(22, "x"), memory: "prefers dark backgrounds everywhere", vec: "[1,0,0,0]", space: REC_SPACE }; // sim 1.0
const FRESH_NEAR = { id: "recz-fresh".padEnd(22, "x"), memory: "prefers light backgrounds lately", vec: "[0.9,0.43589,0,0]", space: REC_SPACE }; // sim 0.9
const AGO_180D = new Date(Date.now() - 180 * 864e5).toISOString();
async function seedRecencySpace(sql: Sql) {
  await sql`INSERT INTO space (id, container_tag, org_id) VALUES (${REC_SPACE}, ${REC_TAG}, ${ORG_ID}) ON CONFLICT (container_tag, org_id) DO NOTHING`;
}

test("recency default: an older exact-topic memory loses to a fresher near-topic memory (B1)", async () => {
  const ctx = await makeCtx();
  try {
    await seedRecencySpace(ctx.sql);
    await insertMemory(ctx.sql, { ...OLD_EXACT, createdAt: AGO_180D });
    await insertMemory(ctx.sql, { ...FRESH_NEAR });
    const results = await searchMemories(ctx as any, { q: "which theme", threshold: 0.5, limit: 5, containerTag: REC_TAG });
    // Fixture ids are chosen so the id TIE-BREAK favors OLD — fresh-first can only come from a real,
    // finite decay, never from NaN falling through to the tiebreak (review follow-up A).
    expect(results[0]!.id).toBe(FRESH_NEAR.id);
    expect(Number.isFinite(results[0]!.score)).toBe(true);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score); // strict ordering by magnitude, not tiebreak
    expect(results.map((r) => r.id)).toContain(OLD_EXACT.id); // decayed, not dropped
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("recency off (opts.recency:false): the older exact-topic memory wins again (B2)", async () => {
  const ctx = await makeCtx();
  try {
    await seedRecencySpace(ctx.sql);
    await insertMemory(ctx.sql, { ...OLD_EXACT, createdAt: AGO_180D });
    await insertMemory(ctx.sql, { ...FRESH_NEAR });
    const results = await searchMemories(ctx as any, { q: "which theme", threshold: 0.5, limit: 5, containerTag: REC_TAG, recency: false });
    expect(results[0]!.id).toBe(OLD_EXACT.id);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("recency env knobs are read PER CALL: weight 0 disables, then default resumes (B3)", async () => {
  const ctx = await makeCtx();
  try {
    await seedRecencySpace(ctx.sql);
    await insertMemory(ctx.sql, { ...OLD_EXACT, createdAt: AGO_180D });
    await insertMemory(ctx.sql, { ...FRESH_NEAR });
    process.env.BELLA_RECENCY_WEIGHT = "0";
    const off = await searchMemories(ctx as any, { q: "which theme", threshold: 0.5, limit: 5, containerTag: REC_TAG });
    expect(off[0]!.id).toBe(OLD_EXACT.id); // env-disabled without rebuilding anything
    delete process.env.BELLA_RECENCY_WEIGHT;
    const on = await searchMemories(ctx as any, { q: "which theme", threshold: 0.5, limit: 5, containerTag: REC_TAG });
    expect(on[0]!.id).toBe(FRESH_NEAR.id); // default weight resumes on the very next call
  } finally {
    delete process.env.BELLA_RECENCY_WEIGHT;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("recency knob semantics: invalid falls back to defaults, out-of-range clamps (B4)", async () => {
  try {
    delete process.env.BELLA_RECENCY_WEIGHT;
    delete process.env.BELLA_RECENCY_TAU_DAYS;
    expect(recencyWeight()).toBe(0.15); // documented default
    expect(recencyTauDays()).toBe(90);
    process.env.BELLA_RECENCY_WEIGHT = "banana";
    expect(recencyWeight()).toBe(0.15); // invalid -> FALLBACK to default
    process.env.BELLA_RECENCY_WEIGHT = "-1";
    expect(recencyWeight()).toBe(0.15); // negative is invalid -> fallback
    process.env.BELLA_RECENCY_WEIGHT = "2";
    expect(recencyWeight()).toBe(1); // numeric but out of range -> CLAMP
    process.env.BELLA_RECENCY_WEIGHT = "0";
    expect(recencyWeight()).toBe(0); // explicit 0 = disabled, honored
    process.env.BELLA_RECENCY_TAU_DAYS = "0";
    expect(recencyTauDays()).toBe(90); // tau <= 0 is invalid -> fallback
    process.env.BELLA_RECENCY_TAU_DAYS = "30";
    expect(recencyTauDays()).toBe(30);
  } finally {
    delete process.env.BELLA_RECENCY_WEIGHT;
    delete process.env.BELLA_RECENCY_TAU_DAYS;
  }
});

test("results carry the fused score, ordered by it (memories)", async () => {
  const ctx = await makeCtx();
  try {
    await seedRecencySpace(ctx.sql);
    await insertMemory(ctx.sql, { ...OLD_EXACT, createdAt: AGO_180D });
    await insertMemory(ctx.sql, { ...FRESH_NEAR });
    const results = await searchMemories(ctx as any, { q: "which theme", threshold: 0.5, limit: 5, containerTag: REC_TAG });
    expect(typeof results[0]!.score).toBe("number");
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores); // descending by fused score
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

// --- Thermonuclear review D1: ONE fusion primitive, tie-break universal (was memories-only) ---

test("chunk fusion tie-break is deterministic: the literal keyword hit wins an RRF tie", async () => {
  const ctx = await makeCtx();
  try {
    // Both chunks rank #1 in their leg for this query -> equal RRF score. Pre-D1 the order fell to
    // Map insertion (vector leg first); the rule is now universal: literal text evidence wins ties.
    const results = await searchChunks(ctx as any, { q: "zebra", threshold: 0.5, limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(chunkKwId);
    expect(results[0]!.source).toBe("keyword");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("hybrid fusion tie-break is deterministic: memories (the primary object) win cross-type ties", async () => {
  const ctx = await makeCtx();
  try {
    // m1 (memories leg #1) and chunkVec (chunks leg #1) tie on RRF; memories are the primary object
    // and now win ties EXPLICITLY instead of by insertion luck.
    const results = await search(ctx as any, { q: "alpha", threshold: 0.5, limit: 2, searchMode: "hybrid" });
    expect(results[0]!.type).toBe("memory");
    expect(results[0]!.id).toBe(memIds[0]);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
