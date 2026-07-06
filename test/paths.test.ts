// paths.test.ts - the disk-footprint helpers (dirSizeBytes recursion + symlink skip, diskUsedBytes,
// diskBudgetMb parsing) and the resolved-storage layout (storageDirs + the ensure()ing accessors).
//
// NOT testable in-process: the BELLA_HOME / BELLA_DATA_DIR / BELLA_CACHE_DIR / BELLA_LOG_DIR overrides
// and the nested-root branch of diskUsedBytes. dataBase/cacheBase/logBase are module-level constants
// captured at import time, and src/db.ts (imported by every DB test file) loads paths.ts at process
// start — so by the time any test runs, the bases are frozen to the real environment. Same reason
// writeEmbedderMeta stays untested: it would overwrite the REAL install's embedder.json pin.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readdirSync } from "node:fs";
import {
  dirSizeBytes,
  diskUsedBytes,
  diskBudgetMb,
  storageDirs,
  dataDir,
  dbDir,
  modelsDir,
  runtimeDir,
  logsDir,
  readEmbedderMetaFrom,
  writeEmbedderMetaFrom,
} from "../src/paths";

test("dirSizeBytes: sums nested files, returns 0 for a missing dir, and never follows symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "bella-paths-"));
  try {
    writeFileSync(join(root, "a.bin"), Buffer.alloc(100));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.bin"), Buffer.alloc(23));
    expect(dirSizeBytes(root)).toBe(123);
    expect(dirSizeBytes(join(root, "does-not-exist"))).toBe(0); // missing dir = 0, not a throw

    // A link to a tree with real bytes contributes ZERO (no cycles, no external inflation).
    // "junction" works unprivileged on Windows and degrades to a plain symlink elsewhere.
    const target = mkdtempSync(join(tmpdir(), "bella-paths-target-"));
    try {
      writeFileSync(join(target, "big.bin"), Buffer.alloc(4096));
      symlinkSync(target, join(root, "link"), "junction");
      expect(dirSizeBytes(root)).toBe(123);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diskBudgetMb: BELLA_DISK_BUDGET_MB is read per call; non-numeric or non-positive means unlimited (0)", () => {
  try {
    delete process.env.BELLA_DISK_BUDGET_MB;
    expect(diskBudgetMb()).toBe(0); // unset -> unlimited
    process.env.BELLA_DISK_BUDGET_MB = "512";
    expect(diskBudgetMb()).toBe(512);
    process.env.BELLA_DISK_BUDGET_MB = "500MB"; // documented coercion: NaN -> 0, never a silent NaN cap
    expect(diskBudgetMb()).toBe(0);
    process.env.BELLA_DISK_BUDGET_MB = "-3";
    expect(diskBudgetMb()).toBe(0);
    process.env.BELLA_DISK_BUDGET_MB = "0";
    expect(diskBudgetMb()).toBe(0);
  } finally {
    delete process.env.BELLA_DISK_BUDGET_MB;
  }
});

test("storageDirs: fixed sublayout under the resolved bases (db under data; models/runtime under cache)", () => {
  const d = storageDirs();
  expect(d.db).toBe(join(d.data, "db"));
  expect(d.models).toBe(join(d.cache, "models"));
  expect(d.runtime).toBe(join(d.cache, "runtime"));
  expect(typeof d.logs).toBe("string");
});

// These accessors ensure() the app's own standard per-user dirs — the exact dirs the server creates at
// boot; mkdir is recursive + non-destructive by module contract, so this is safe to run on any machine.
test("dir accessors return the storageDirs paths and create them", () => {
  const d = storageDirs();
  expect(dataDir()).toBe(d.data);
  expect(dbDir()).toBe(d.db);
  expect(modelsDir()).toBe(d.models);
  expect(runtimeDir()).toBe(d.runtime);
  expect(logsDir()).toBe(d.logs);
  for (const p of [d.data, d.db, d.models, d.runtime, d.logs]) expect(existsSync(p)).toBe(true);
});

test("diskUsedBytes: finite, non-negative, and at least the data dir's footprint (roots deduped, never double-counted negative)", () => {
  const used = diskUsedBytes();
  expect(Number.isFinite(used)).toBe(true);
  expect(used).toBeGreaterThanOrEqual(0);
  // data is always measured — either as its own root or inside a shared parent root — so the total
  // can never come in below it, whatever the env layout.
  expect(used).toBeGreaterThanOrEqual(dirSizeBytes(storageDirs().data));
});

test("readEmbedderMetaFrom: absent -> null; valid -> {model,dim}; corrupt/malformed -> THROWS, never a silent null (#127)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bella-embmeta-"));
  try {
    const p = join(dir, "embedder.json");
    expect(readEmbedderMetaFrom(p)).toBeNull(); // ENOENT = fresh install, quiet
    writeFileSync(p, JSON.stringify({ model: "e5-small", dim: 384 }));
    expect(readEmbedderMetaFrom(p)).toEqual({ model: "e5-small", dim: 384 });
    // The pin exists to STOP a silent dim/model flip — a broken pin must fail loudly, not fall back to
    // "absent" (which re-derives the tier from RAM and can corrupt an existing store).
    writeFileSync(p, "{not json");
    expect(() => readEmbedderMetaFrom(p)).toThrow();
    writeFileSync(p, JSON.stringify({ model: "x" })); // missing dim
    expect(() => readEmbedderMetaFrom(p)).toThrow();
    writeFileSync(p, "null"); // valid JSON, not a pin
    expect(() => readEmbedderMetaFrom(p)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEmbedderMetaFrom: atomic write round-trips and leaves no temp file behind (#127)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bella-embmeta-w-"));
  try {
    const p = join(dir, "embedder.json");
    writeEmbedderMetaFrom(p, "e5-small", 384);
    expect(readEmbedderMetaFrom(p)).toEqual({ model: "e5-small", dim: 384 });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toHaveLength(0); // temp+rename left nothing torn
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
