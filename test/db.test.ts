// Covers the review-hardening logic added to db.ts: the EMBED_DIM guard (range + on-disk mismatch) and
// the single-writer lock (fresh acquire / live-holder refusal / stale reclaim).
import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

test("acquireDbLock: writes our pid; reclaims OWN pid; refuses live/dead-foreign/garbage; release guards ownership", async () => {
  const lockPath = join(tmpdir(), `eunoia-lock-test-${process.pid}.lock`);
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
  expect(() => acquireDbLock(lockPath)).toThrow(/already open by another Eunoia process/);
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

test("concurrent acquirers never double-acquire while a live holder exists", async () => {
  const lockPath = join(tmpdir(), `eunoia-lock-conc-${process.pid}.lock`);
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
