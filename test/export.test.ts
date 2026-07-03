// export.test.ts - SPEC-P1.9: portable memory. Round-trip through the REAL routes on both sides:
// source app seeds via POST /memories (supersede stamps windows) / forget / PUT profile /
// POST /documents, then GET /export -> POST /import into a FRESH app with a DIFFERENT embedder.
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { memoriesRoutes } from "../src/memories";
import { documentsRoutes } from "../src/documents";
import { profileRoutes } from "../src/profile";
import { exportRoutes, importRoutes } from "../src/export";
import { ORG_ID, DEFAULT_CONTAINER_TAG, toVector } from "../src/util";
import { EMBED_DIM } from "../src/embed-common";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 20000;
const pad = (v: number[]): number[] => [...v, ...new Array(Math.max(EMBED_DIM - v.length, 0)).fill(0)];

// Source-side embedder: content-keyed; dark/light mode are near-duplicates (cosine ~0.95) so the
// second write SUPERSEDES the first, stamping validity windows via the real tx path.
const SOURCE_VECTORS: Record<string, number[]> = {
  "John prefers dark mode": pad([1, 0, 0, 0]),
  "John prefers light mode": pad([0.95, 0.312, 0, 0]),
  "John lives in Denver": pad([0, 1, 0, 0]),
};
const sourceEmbed: Embed = async ({ values }) => values.map((v) => SOURCE_VECTORS[v] ?? pad([0, 0, 0, 1]));

// Target-side embedder is DIFFERENT on purpose: every stored vector after import must come from
// THIS embedder (B2) — the export file carries no embeddings to trust.
const TARGET_VEC = pad([0, 0, 1, 0]);
let targetEmbedCalls = 0;
const targetEmbed: Embed = async ({ values }) => {
  targetEmbedCalls += values.length;
  return values.map(() => TARGET_VEC);
};

async function makeApp(embed: Embed) {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  const ctx = { sql, embed };
  const app = new Hono();
  app.route("/memories", memoriesRoutes(ctx));
  app.route("/documents", documentsRoutes(ctx));
  app.route("/profile", profileRoutes(ctx));
  app.route("/export", exportRoutes(ctx));
  app.route("/import", importRoutes(ctx));
  return { app, sql, close: () => sql.end() };
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Seed: a 2-version chain (windows stamped by the real supersede tx), a forgotten memory, a
// profile, and a document (chunked+embedded by the real ingest path).
async function seedSource(app: Hono) {
  process.env.BELLA_SUPERSEDE_THRESHOLD = "0.9";
  try {
    const first = await (await post(app, "/memories", { memories: [{ content: "John prefers dark mode" }] })).json();
    const v1 = first.memories[0].id as string;
    const second = await (await post(app, "/memories", { memories: [{ content: "John prefers light mode" }] })).json();
    expect(second.memories[0].action).toBe("superseded");
    const v2 = second.memories[0].id as string;
    const den = await (await post(app, "/memories", { memories: [{ content: "John lives in Denver" }] })).json();
    const forgottenId = den.memories[0].id as string;
    await post(app, `/memories/${forgottenId}/forget`, { reason: "moved away" });
    await put(app, "/profile", { static: ["prefers metric units"], dynamic: ["recently asked about themes"] });
    await post(app, "/documents", { title: "Setup guide", content: "# Setup\n\nRun the doctor command first.\n\n## Details\n\nChunking needs enough text to produce at least one chunk of content here." });
    return { v1, v2, forgottenId };
  } finally {
    delete process.env.BELLA_SUPERSEDE_THRESHOLD;
  }
}

test("export -> import round-trips chains (windows intact), forgotten status, profile, and documents (B1)", async () => {
  const src = await makeApp(sourceEmbed);
  const dst = await makeApp(targetEmbed);
  try {
    await seedSource(src.app);
    const exp = await (await src.app.request("/export")).json();
    expect(exp.format).toBe("bellamente-export");
    expect(exp.version).toBe(1);

    const res = await post(dst.app, "/import", exp);
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.imported.chains).toBe(2); // the 2-version chain + the forgotten single
    expect(report.imported.versions).toBe(3);
    expect(report.imported.documents).toBe(1);

    // Chain shape: 2 versions, one root, head is v2 with is_latest.
    const chain = await dst.sql`
      SELECT id, memory, version, is_latest, parent_memory_id, root_memory_id, valid_from, valid_to
      FROM memory_entry WHERE org_id = ${ORG_ID} AND memory IN ('John prefers dark mode', 'John prefers light mode')
      ORDER BY version ASC`;
    expect(chain).toHaveLength(2);
    expect(chain[0]!.is_latest).toBe(false);
    expect(chain[1]!.is_latest).toBe(true);
    expect(Number(chain[1]!.version)).toBe(2);
    // Validity windows survive verbatim: the exported flip boundary is preserved exactly.
    const expChain = exp.containers[0].chains.find((ch: any) => ch.versions.length === 2);
    expect(new Date(chain[0]!.valid_to).toISOString()).toBe(expChain.versions[0].validTo);
    expect(new Date(chain[1]!.valid_from).toISOString()).toBe(expChain.versions[1].validFrom);
    expect(chain[0]!.valid_from).toBeNull();
    expect(chain[1]!.valid_to).toBeNull();

    // Forgotten status survives.
    const [fg] = await dst.sql`SELECT is_forgotten, forget_reason FROM memory_entry WHERE memory = ${"John lives in Denver"}`;
    expect(fg!.is_forgotten).toBe(true);
    expect(fg!.forget_reason).toBe("moved away");

    // Profile round-trips through the real routes.
    const prof = await (await dst.app.request("/profile")).json();
    expect(prof.static).toEqual(["prefers metric units"]);
    expect(prof.dynamic).toEqual(["recently asked about themes"]);

    // Document present with REGENERATED chunks.
    const docs = await dst.sql`SELECT id, title FROM document WHERE org_id = ${ORG_ID}`;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("Setup guide");
    const [nchunks] = await dst.sql`SELECT count(*)::int AS n FROM chunk WHERE document_id = ${docs[0]!.id}`;
    expect(Number(nchunks!.n)).toBeGreaterThanOrEqual(1);
  } finally {
    await src.close();
    await dst.close();
  }
}, TEST_TIMEOUT_MS);

test("embeddings are never in the file and always regenerate through the LOCAL embedder (B2)", async () => {
  const src = await makeApp(sourceEmbed);
  const dst = await makeApp(targetEmbed);
  try {
    await seedSource(src.app);
    const exp = await (await src.app.request("/export")).json();
    // The export document carries NO vectors anywhere.
    const raw = JSON.stringify(exp);
    expect(raw.includes("embedding")).toBe(false);
    expect(raw.includes("memory_embedding")).toBe(false);

    targetEmbedCalls = 0;
    await post(dst.app, "/import", exp);
    expect(targetEmbedCalls).toBeGreaterThan(0);
    // Stored vector == the TARGET embedder's output (cosine 1.0), not the source's.
    const [row] = await dst.sql`
      SELECT 1 - (memory_embedding <=> ${toVector(TARGET_VEC)}::vector) AS sim
      FROM memory_entry WHERE memory = ${"John prefers light mode"}`;
    expect(Number(row!.sim)).toBeGreaterThan(0.999);
  } finally {
    await src.close();
    await dst.close();
  }
}, TEST_TIMEOUT_MS);

test("import maps old ids to fresh ids while preserving chain relations (B3)", async () => {
  const src = await makeApp(sourceEmbed);
  const dst = await makeApp(targetEmbed);
  try {
    const { v1, v2, forgottenId } = await seedSource(src.app);
    const exp = await (await src.app.request("/export")).json();
    await post(dst.app, "/import", exp);

    const all = await dst.sql`SELECT id, memory, parent_memory_id, root_memory_id, memory_relations FROM memory_entry WHERE org_id = ${ORG_ID}`;
    const ids = new Set(all.map((r) => r.id));
    for (const old of [v1, v2, forgottenId]) expect(ids.has(old)).toBe(false);

    const v1New = all.find((r) => r.memory === "John prefers dark mode")!;
    const v2New = all.find((r) => r.memory === "John prefers light mode")!;
    expect(v2New.parent_memory_id).toBe(v1New.id);
    expect(v2New.root_memory_id).toBe(v1New.id);
    expect(v2New.memory_relations?.updates).toEqual([v1New.id]);
  } finally {
    await src.close();
    await dst.close();
  }
}, TEST_TIMEOUT_MS);

test("importing the same file twice is a no-op: chains and documents dedupe, counts unchanged (B4)", async () => {
  const src = await makeApp(sourceEmbed);
  const dst = await makeApp(targetEmbed);
  try {
    await seedSource(src.app);
    const exp = await (await src.app.request("/export")).json();
    await post(dst.app, "/import", exp);
    const countRows = async () => ({
      mems: Number((await dst.sql`SELECT count(*)::int AS n FROM memory_entry`)[0]!.n),
      docs: Number((await dst.sql`SELECT count(*)::int AS n FROM document`)[0]!.n),
    });
    const before = await countRows();

    const second = await (await post(dst.app, "/import", exp)).json();
    expect(second.imported.versions).toBe(0);
    expect(second.skipped.chains).toBeGreaterThanOrEqual(2);
    expect(await countRows()).toEqual(before);
  } finally {
    await src.close();
    await dst.close();
  }
}, TEST_TIMEOUT_MS);

test("bad input: wrong format/version are 400; a broken chain aborts alone while others import (B5)", async () => {
  const dst = await makeApp(targetEmbed);
  try {
    expect((await post(dst.app, "/import", { format: "something-else", version: 1 })).status).toBe(400);
    expect((await post(dst.app, "/import", { format: "bellamente-export", version: 99 })).status).toBe(400);

    const iso = "2026-07-01T00:00:00.000Z";
    const ver = (over: Record<string, unknown>) => ({
      exportId: "x".repeat(22), parentExportId: null, version: 1, isLatest: true,
      memory: "fact", isStatic: false, isInference: false, isForgotten: false,
      forgetAfter: null, forgetReason: null, metadata: null, sourceCount: 1,
      memoryRelations: null, createdAt: iso, updatedAt: iso, validFrom: null, validTo: null,
      ...over,
    });
    const body = {
      format: "bellamente-export", version: 1, exportedAt: iso, embedModel: "test",
      containers: [{
        containerTag: DEFAULT_CONTAINER_TAG, profile: null,
        chains: [
          { versions: [ver({ exportId: "good".padEnd(22, "x"), memory: "standalone good fact" })] },
          // Orphan: claims a parent that is nowhere in the file -> THIS chain fails, others land.
          { versions: [ver({ exportId: "orph".padEnd(22, "x"), parentExportId: "gone".padEnd(22, "x"), version: 2, memory: "orphan v2 fact" })] },
        ],
      }],
      documents: [], provenance: [],
    };
    const res = await post(dst.app, "/import", body);
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.imported.chains).toBe(1);
    expect(report.failed.chains).toBe(1);
    const rows = await dst.sql`SELECT memory FROM memory_entry WHERE org_id = ${ORG_ID}`;
    expect(rows.map((r) => r.memory)).toEqual(["standalone good fact"]);
  } finally {
    await dst.close();
  }
}, TEST_TIMEOUT_MS);
