// paths.ts - SAFE, user-customizable per-user storage following OS conventions via `env-paths`
// (the de-facto cross-platform standard). Bellamente writes ONLY under these dirs - never beside the
// exe, never cwd, never system dirs. mkdir is recursive + non-destructive; no admin/root needed.
//
// Defaults (env-paths):
//   data  (memories/DB) : Win %LOCALAPPDATA%\Bellamente\Data  | macOS ~/Library/Application Support/Bellamente | Linux $XDG_DATA_HOME/bellamente (~/.local/share)
//   cache (models/libs) : Win %LOCALAPPDATA%\Bellamente\Cache | macOS ~/Library/Caches/Bellamente             | Linux $XDG_CACHE_HOME/bellamente (~/.cache)
//   logs                : Win %LOCALAPPDATA%\Bellamente\Log   | macOS ~/Library/Logs/Bellamente               | Linux $XDG_STATE_HOME/bellamente (~/.local/state)
//
// USER OVERRIDES (env vars, easiest first):
//   BELLA_HOME       - put EVERYTHING under one folder (single-folder / portable install)
//   BELLA_DATA_DIR   - relocate just the data (memories/DB)
//   BELLA_CACHE_DIR  - relocate just the cache (model weights / extracted libs) e.g. to a big drive
//   BELLA_LOG_DIR    - relocate just the logs
//   BELLA_MODEL_DIR  - (used by embed.ts) point the model cache anywhere directly
//   DATABASE_URL     - use an external Postgres instead of the embedded DB (dev / advanced)
import envPaths from "env-paths";
import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { brandEnv } from "./env";

// Renamed from the pre-release working-title dir before v0.0.1 shipped — no released install ever
// wrote to the old name, so there is nothing to adopt.
const P = envPaths("Bellamente", { suffix: "" });
const HOME = brandEnv("HOME");
const dataBase = brandEnv("DATA_DIR") ?? HOME ?? P.data;
const cacheBase = brandEnv("CACHE_DIR") ?? HOME ?? P.cache;
const logBase = brandEnv("LOG_DIR") ?? (HOME ? join(HOME, "logs") : P.log);

const ensure = (p: string): string => {
  mkdirSync(p, { recursive: true });
  return p;
};

export const dataDir = (): string => ensure(dataBase);
export const dbDir = (): string => ensure(join(dataBase, "db")); // embedded Postgres (PGlite) — M2

// Embedder identity persisted at first DB init. The auto tier is chosen by device RAM, but the on-disk vector
// dim is fixed once the DB exists — so we PIN the first-boot {model, dim} here and prefer it over re-deriving
// from RAM on every boot. That stops a benign RAM/VM change from flipping the dim and bricking the store.
const EMBEDDER_META = "embedder.json";
// Read the pin from a specific path (extracted so it is unit-testable against a temp dir). ENOENT =
// legitimately absent (fresh install) -> null. Any OTHER failure (corrupt JSON, malformed shape, EACCES)
// must NOT be treated as absent — that silently re-derives the tier from RAM and can flip the dim/model
// on an existing store — so it THROWS a loud, actionable error instead of returning null (#127).
export function readEmbedderMetaFrom(path: string): { model: string; dim: number } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return null;
    throw new Error(`embedder pin at ${path} is unreadable (${(e as { code?: string })?.code ?? String(e)}); fix or remove the file`);
  }
  let m: { model?: unknown; dim?: unknown } | null;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error(`embedder pin at ${path} is corrupt JSON; fix or remove the file`);
  }
  if (m && typeof m.model === "string" && m.model.length > 0 && Number.isInteger(m.dim) && (m.dim as number) > 0) {
    return { model: m.model, dim: m.dim as number };
  }
  throw new Error(`embedder pin at ${path} is missing a valid {model, dim}; fix or remove the file`);
}

// Atomic write (temp + rename) so a crash mid-write can't leave a torn/half pin; a write failure
// propagates (never swallowed) so a broken pin surfaces instead of silently vanishing (#127).
export function writeEmbedderMetaFrom(path: string, model: string, dim: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ model, dim }));
    renameSync(tmp, path);
  } finally {
    try { rmSync(tmp, { force: true }); } catch {} // no torn temp left behind if the write/rename failed
  }
}

export function readEmbedderMeta(): { model: string; dim: number } | null {
  // This runs at module-eval time (embed-common reads it as a top-level const), so a corrupt pin must NOT
  // throw here — that would crash `bella doctor` before it can even diagnose the problem. Log LOUDLY and
  // fall back to null (re-derive the tier from RAM); makeDb's assertEmbeddingDim/assertEmbeddingModel are
  // the graceful, doctor-surfaced backstop that catch a REAL dim/model flip against the existing store,
  // so the pin does not need to be authoritative here (#127 review).
  try {
    return readEmbedderMetaFrom(join(dataBase, EMBEDDER_META));
  } catch (e) {
    console.error(`[paths] ${e instanceof Error ? e.message : String(e)} — re-deriving the embedder tier from RAM; the DB dim/model guards will catch any real mismatch`);
    return null;
  }
}
export function writeEmbedderMeta(model: string, dim: number): void {
  writeEmbedderMetaFrom(join(ensure(dataBase), EMBEDDER_META), model, dim);
}
export const modelsDir = (): string => ensure(join(cacheBase, "models")); // embedding weights cache
export const runtimeDir = (): string => ensure(join(cacheBase, "runtime")); // extracted WASM runtime + glue
export const logsDir = (): string => ensure(logBase);

// --- Resource-safety helpers: measure on-disk footprint + enforce an optional soft budget. ---
// Uses lstatSync (does NOT follow symlinks): a symlink cycle can't cause infinite recursion, and a
// symlink to a large external tree isn't walked or counted as that tree.
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // missing dir = 0 bytes
  }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue; // skip links (count nothing) — avoids cycles + external inflation
      total += st.isDirectory() ? dirSizeBytes(p) : st.size;
    } catch {}
  }
  return total;
}

/** Total bytes Bellamente is using on disk (data + cache; logs excluded — safely deletable + small).
 *  Dedupes overlapping roots so BELLA_HOME (data===cache===HOME) isn't double-counted. */
export const diskUsedBytes = (): number => {
  const roots = [...new Set([resolve(dataBase), resolve(cacheBase)])];
  // Drop any root nested inside another so a shared parent (e.g. BELLA_HOME) is measured once.
  const top = roots.filter((r) => !roots.some((o) => o !== r && (r.startsWith(o + "/") || r.startsWith(o + "\\"))));
  return top.reduce((sum, r) => sum + dirSizeBytes(r), 0);
};

/** Soft disk cap in MB (0 = unlimited). User sets BELLA_DISK_BUDGET_MB. A non-numeric value (e.g. "500MB")
 *  coerces to 0 (unlimited) rather than NaN, which would silently disable the cap in the > 0 consumers. */
export const diskBudgetMb = (): number => {
  const n = Number(brandEnv("DISK_BUDGET_MB") ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Resolved storage locations, for `bella doctor` and diagnostics. */
export const storageDirs = () => ({
  data: dataBase,
  db: join(dataBase, "db"),
  cache: cacheBase,
  models: join(cacheBase, "models"),
  runtime: join(cacheBase, "runtime"),
  logs: logBase,
});
