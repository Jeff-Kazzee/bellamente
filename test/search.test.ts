// search.test.ts - fusion correctness for searchChunks (threshold on the vector leg) and
// top-level hybrid mode (rank-based RRF instead of raw-score sorting across incompatible scales).
import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { search, searchChunks } from "../src/search";
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
