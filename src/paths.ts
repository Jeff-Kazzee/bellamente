// paths.ts - SAFE, user-customizable per-user storage following OS conventions via `env-paths`
// (the de-facto cross-platform standard). Eunoia writes ONLY under these dirs - never beside the
// exe, never cwd, never system dirs. mkdir is recursive + non-destructive; no admin/root needed.
//
// Defaults (env-paths):
//   data  (memories/DB) : Win %LOCALAPPDATA%\Eunoia\Data  | macOS ~/Library/Application Support/Eunoia | Linux $XDG_DATA_HOME/eunoia (~/.local/share)
//   cache (models/libs) : Win %LOCALAPPDATA%\Eunoia\Cache | macOS ~/Library/Caches/Eunoia             | Linux $XDG_CACHE_HOME/eunoia (~/.cache)
//   logs                : Win %LOCALAPPDATA%\Eunoia\Log   | macOS ~/Library/Logs/Eunoia               | Linux $XDG_STATE_HOME/eunoia (~/.local/state)
//
// USER OVERRIDES (env vars, easiest first):
//   EUNOIA_HOME       - put EVERYTHING under one folder (single-folder / portable install)
//   EUNOIA_DATA_DIR   - relocate just the data (memories/DB)
//   EUNOIA_CACHE_DIR  - relocate just the cache (model weights / extracted libs) e.g. to a big drive
//   EUNOIA_LOG_DIR    - relocate just the logs
//   EUNOIA_MODEL_DIR  - (used by embed.ts) point the model cache anywhere directly
//   DATABASE_URL      - use an external Postgres instead of the embedded DB (dev / advanced)
import envPaths from "env-paths";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const P = envPaths("Eunoia", { suffix: "" });
const HOME = process.env.EUNOIA_HOME;
const dataBase = process.env.EUNOIA_DATA_DIR ?? HOME ?? P.data;
const cacheBase = process.env.EUNOIA_CACHE_DIR ?? HOME ?? P.cache;
const logBase = process.env.EUNOIA_LOG_DIR ?? (HOME ? join(HOME, "logs") : P.log);

const ensure = (p: string): string => {
  mkdirSync(p, { recursive: true });
  return p;
};

export const dataDir = (): string => ensure(dataBase);
export const dbDir = (): string => ensure(join(dataBase, "db")); // embedded Postgres (PGlite) — M2
export const modelsDir = (): string => ensure(join(cacheBase, "models")); // embedding weights cache
export const runtimeDir = (): string => ensure(join(cacheBase, "runtime")); // extracted native libs — M2
export const logsDir = (): string => ensure(logBase);

// --- Resource-safety helpers: measure on-disk footprint + enforce an optional soft budget. ---
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
      const st = statSync(p);
      total += st.isDirectory() ? dirSizeBytes(p) : st.size;
    } catch {}
  }
  return total;
}

/** Total bytes Eunoia is using on disk (data + cache; logs excluded — safely deletable + small). */
export const diskUsedBytes = (): number => dirSizeBytes(dataBase) + dirSizeBytes(cacheBase);

/** Soft disk cap in MB (0 = unlimited). User sets EUNOIA_DISK_BUDGET_MB. */
export const diskBudgetMb = (): number => Math.max(0, Number(process.env.EUNOIA_DISK_BUDGET_MB ?? 0));

/** Resolved storage locations, for `eunoia doctor` and diagnostics. */
export const storageDirs = () => ({
  data: dataBase,
  db: join(dataBase, "db"),
  cache: cacheBase,
  models: join(cacheBase, "models"),
  runtime: join(cacheBase, "runtime"),
  logs: logBase,
});
