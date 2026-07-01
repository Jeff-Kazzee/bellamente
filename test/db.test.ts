// Covers the review-hardening logic added to db.ts: the EMBED_DIM guard (range + on-disk mismatch) and
// the single-writer lock (fresh acquire / live-holder refusal / stale reclaim).
import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim, assertEmbeddingDim, acquireDbLock } from "../src/db";

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
});

test("acquireDbLock: fresh acquire, live-holder refusal, stale reclaim", async () => {
  const lockPath = join(tmpdir(), `eunoia-lock-test-${process.pid}.lock`);
  rmSync(lockPath, { force: true });

  const release = acquireDbLock(lockPath);
  expect(existsSync(lockPath)).toBe(true);

  // A live, DIFFERENT holder -> refuse loudly.
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"]);
  writeFileSync(lockPath, String(child.pid));
  expect(() => acquireDbLock(lockPath)).toThrow(/already open by another Eunoia process/);

  // An empty/garbage lockfile (a peer mid-openSync-before-writeSync) -> refuse, do NOT reclaim (fail-safe).
  writeFileSync(lockPath, "");
  expect(() => acquireDbLock(lockPath)).toThrow(/appears held by another starting process/);
  writeFileSync(lockPath, "not-a-pid");
  expect(() => acquireDbLock(lockPath)).toThrow(/appears held by another starting process/);

  // A stale (dead-pid) holder -> reclaim and acquire.
  child.kill();
  await child.exited;
  writeFileSync(lockPath, String(child.pid)); // now a dead pid
  const release2 = acquireDbLock(lockPath);
  expect(existsSync(lockPath)).toBe(true);

  release2();
  release();
  rmSync(lockPath, { force: true });
});
