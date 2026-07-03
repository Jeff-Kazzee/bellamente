// Covers the review-hardening logic added to db.ts: the EMBED_DIM guard (range + on-disk mismatch) and
// the single-writer lock (fresh acquire / live-holder refusal / stale reclaim).
import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim, assertEmbeddingDim, assertEmbeddingModel, acquireDbLock } from "../src/db";
import { runMigrations, MIGRATIONS } from "../src/migrations";
import { isValidVector, EMBED_DIM } from "../src/embed-common";

test("schemaForDim rewrites vector(384) -> vector(dim) and rejects out-of-range", () => {
  const s = schemaForDim(256);
  expect(s).toContain("vector(256)");
  expect(s).not.toContain("vector(384)");
  for (const bad of [0, -1, 1.5, 2001, 16000, NaN]) expect(() => schemaForDim(bad)).toThrow();
  for (const ok of [1, 384, 768, 1024, 2000]) expect(() => schemaForDim(ok)).not.toThrow();
});

test("assertEmbeddingDim passes on match, throws on a dimension switch", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8)); // creates the embedding columns at vector(8)
  await assertEmbeddingDim(sql, 8); // matches -> no throw
  await expect(assertEmbeddingDim(sql, 16)).rejects.toThrow(/on-disk embedding dimension is 8 but EMBED_DIM=16/);
  await sql.end();
}, 20000);

test("assertEmbeddingModel passes on a fresh DB and on match; throws on a same-dim model swap", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8));
  await assertEmbeddingModel(sql, "model-a"); // fresh DB (no rows) -> never refuses
  await sql`INSERT INTO memory_entry (id, org_id, space_id, memory, memory_embedding_model)
            VALUES (${"a".repeat(22)}, ${"org"}, ${"s".repeat(22)}, ${"hi"}, ${"model-a"})`;
  await assertEmbeddingModel(sql, "model-a"); // matches -> ok
  await expect(assertEmbeddingModel(sql, "model-b")).rejects.toThrow(/produced by \[model-a\] but the active/);
  // Already-MIXED store: model-a matches some rows but model-b rows exist -> must still refuse.
  await sql`INSERT INTO memory_entry (id, org_id, space_id, memory, memory_embedding_model)
            VALUES (${"b".repeat(22)}, ${"org"}, ${"s".repeat(22)}, ${"yo"}, ${"model-b"})`;
  await expect(assertEmbeddingModel(sql, "model-a")).rejects.toThrow(/produced by \[model-b\]/);
  await sql.end();
}, 20000);

test("isValidVector rejects an all-zero vector (whitespace/OOV), accepts a real one", () => {
  const zero = new Array(EMBED_DIM).fill(0);
  const real = new Array(EMBED_DIM).fill(0);
  real[0] = 1;
  expect(isValidVector(zero)).toBe(false);
  expect(isValidVector(real)).toBe(true);
  expect(isValidVector(new Array(EMBED_DIM).fill(NaN))).toBe(false);
});

test("acquireDbLock: writes our pid; reclaims OWN pid; refuses live/dead-foreign/garbage; release guards ownership", async () => {
  const lockPath = join(tmpdir(), `bella-lock-test-${process.pid}.lock`);
  rmSync(lockPath, { force: true });

  // fresh acquire -> the file actually holds OUR pid (not just "exists")
  const release = acquireDbLock(lockPath);
  expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));

  // our OWN stale pid (a dev hot reload) -> reclaimed in-process (race-free), still ours
  writeFileSync(lockPath, String(process.pid));
  const releaseOwn = acquireDbLock(lockPath);
  expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));

  // a LIVE, different holder -> refuse
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"]);
  writeFileSync(lockPath, String(child.pid));
  expect(() => acquireDbLock(lockPath)).toThrow(/already open by another Bellamente process/);
  child.kill();
  await child.exited;

  // a DEAD, different holder -> REFUSE (no cross-process reclaim; that would be a double-writer TOCTOU)
  writeFileSync(lockPath, "2147483647"); // a pid that is not running
  expect(() => acquireDbLock(lockPath)).toThrow(/Not auto-reclaiming/);

  // empty / garbage -> refuse (fail-safe)
  writeFileSync(lockPath, "");
  expect(() => acquireDbLock(lockPath)).toThrow(/appears held by another starting process/);
  writeFileSync(lockPath, "not-a-pid");
  expect(() => acquireDbLock(lockPath)).toThrow(/appears held by another starting process/);

  // release() only unlinks a lock still holding OUR pid — never one another process now owns
  writeFileSync(lockPath, String(process.pid));
  const rel = acquireDbLock(lockPath);
  writeFileSync(lockPath, "424242"); // someone else "took over" the file
  rel();
  expect(existsSync(lockPath)).toBe(true);
  expect(readFileSync(lockPath, "utf8").trim()).toBe("424242");

  releaseOwn();
  release();
  rmSync(lockPath, { force: true });
});

test("runMigrations: applies once, records in schema_migrations, re-run is a no-op", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8)); // fresh install: schema.sql already at the final shape
  const first = await runMigrations(sql);
  expect(first).toEqual(MIGRATIONS.map((m) => m.id)); // idempotent SQL runs clean against final schema
  const rows = await sql`SELECT id, name FROM schema_migrations ORDER BY id`;
  expect(rows.map((r) => Number(r.id))).toEqual(MIGRATIONS.map((m) => m.id));
  const second = await runMigrations(sql);
  expect(second).toEqual([]); // already recorded -> nothing re-applied
  await sql.end();
}, 20000);

test("runMigrations: brings a legacy install (missing new indexes) up to date", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8));
  // Simulate a pre-migration install: the index exists in today's schema.sql but not on an old DB.
  await sql.unsafe("DROP INDEX idx_memory_entry_latest");
  await runMigrations(sql);
  const idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = ${"idx_memory_entry_latest"}`;
  expect(idx.length).toBe(1);
  await sql.end();
}, 20000);

test("runMigrations: memory full-text GIN index ships to legacy installs (003) and fresh installs via schema.sql (B6)", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8));
  // Fresh install: schema.sql itself creates the index (migrations then no-op over it).
  let idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = ${"idx_memory_entry_fulltext"}`;
  expect(idx.length).toBe(1);
  // Legacy install: the index predates migration 003 on disk — drop it, migrations bring it back.
  await sql.unsafe("DROP INDEX idx_memory_entry_fulltext");
  await runMigrations(sql);
  idx = await sql`SELECT indexname FROM pg_indexes WHERE indexname = ${"idx_memory_entry_fulltext"}`;
  expect(idx.length).toBe(1);
  // Idempotent: a re-run applies nothing and leaves the index in place.
  const again = await runMigrations(sql);
  expect(again).toEqual([]);
  await sql.end();
}, 20000);

test("runMigrations: a failing migration rolls back atomically (no SQL applied, no row recorded)", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8));
  const boom = [{ id: 99, name: "boom", up: "CREATE TABLE mig_atomic_probe (id int); SELECT no_such_function_xyz();" }];
  await expect(runMigrations(sql, boom)).rejects.toThrow();
  const probe = await sql`SELECT to_regclass(${"mig_atomic_probe"}) AS t`;
  expect(probe[0]!.t).toBeNull(); // the CREATE TABLE inside the failed migration rolled back
  const rows = await sql`SELECT id FROM schema_migrations WHERE id = 99`;
  expect(rows.length).toBe(0); // ...and no completion row was recorded
  await sql.end();
}, 20000);

test("concurrent acquirers never double-acquire while a live holder exists", async () => {
  const lockPath = join(tmpdir(), `bella-lock-conc-${process.pid}.lock`);
  rmSync(lockPath, { force: true });
  const held = acquireDbLock(lockPath); // this test process is a LIVE holder
  const childPath = join(import.meta.dir, "lock-child.ts");
  const kids = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, childPath, lockPath], { stdout: "pipe", stderr: "pipe" }));
  const outs = await Promise.all(kids.map((k) => new Response(k.stdout).text()));
  await Promise.all(kids.map((k) => k.exited));
  expect(outs.filter((o) => o.includes("ACQUIRED")).length).toBe(0); // a live holder blocks every other process
  expect(outs.filter((o) => o.includes("REFUSED")).length).toBe(4);
  held();
  rmSync(lockPath, { force: true });
});

test("migration 003 and schema.sql produce the IDENTICAL index definition (B6 strengthened)", async () => {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(8));
  await runMigrations(sql); // creates schema_migrations + records 1-3 (index already present via schema.sql)
  const [fresh] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${"idx_memory_entry_fulltext"}`;
  await sql.unsafe("DROP INDEX idx_memory_entry_fulltext");
  await sql`DELETE FROM schema_migrations WHERE id = 3`;
  await runMigrations(sql);
  const [migrated] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${"idx_memory_entry_fulltext"}`;
  // a same-named index with a different expression/method/config in either source would pass a
  // bare existence check; the definitions themselves must match exactly
  expect(migrated!.indexdef).toBe(fresh!.indexdef);
  expect(String(fresh!.indexdef)).toContain("gin");
  expect(String(fresh!.indexdef)).toContain("to_tsvector('simple'");
  await sql.end();
}, 20000);
