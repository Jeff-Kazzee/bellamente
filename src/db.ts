// db.ts - the single DB handle.
// DEFAULT: embedded PGlite (Postgres compiled to WASM) running IN-PROCESS inside the binary — no Docker,
// no server, no external dependency. pgvector rides along as an in-process bundled extension.
// ADVANCED OVERRIDE: external Postgres+pgvector via DATABASE_URL (dev / power users).
// Either way the tuned SQL in search.ts/memories.ts/etc. is unchanged — a porsager-compatible shim
// (pg-shim.ts) runs it against PGlite.
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openSync, closeSync, writeSync, readFileSync, rmSync } from "node:fs";
import { EMBED_DIM } from "./embed-common";
import { dataDir, dbDir, runtimeDir } from "./paths";
import { makePgliteSql, type DB } from "./pg-shim";
import schemaSql from "../schema.sql" with { type: "text" };

// Embed the PGlite runtime into the compiled binary. In `bun --compile`, `type:"file"` imports are packed
// into the binary's virtual FS; at boot we hand the bytes to PGlite directly (a compiled WebAssembly.Module
// + a Blob) so it never has to resolve a `$bunfs` URL (which its Node loader can't fs.readFile). In
// `bun run dev` these resolve to real node_modules paths and PGlite's own defaults are used instead.
import pgliteWasmUrl from "../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import initdbWasmUrl from "../node_modules/@electric-sql/pglite/dist/initdb.wasm" with { type: "file" };
import pgliteDataUrl from "../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };
import vectorTarUrl from "../node_modules/@electric-sql/pglite/dist/vector.tar.gz" with { type: "file" };

export type { DB } from "./pg-shim";

// The embedding dimension is spliced into DDL, so it must be a plain positive integer (never user text).
// It also caps at 2000: schema.sql builds pgvector HNSW indexes on the embedding columns, and pgvector's
// hnsw index caps an INDEXABLE vector at 2000 dims (a bare vector column allows up to 16000, but the index
// does not). Larger models must be Matryoshka-truncated (mrl()) to <=2000. (e5-small=384, potion=256/512,
// bge=768, Qwen3-0.6B=1024 — all fit.)
export function schemaForDim(dim: number): string {
  if (!Number.isInteger(dim) || dim < 1 || dim > 2000) {
    throw new Error(`invalid EMBED_DIM ${dim} (expected an integer 1..2000; pgvector's hnsw index caps at 2000 dims)`);
  }
  return schemaSql.replaceAll("vector(384)", `vector(${dim})`);
}

// Changing the embedding model's dimension on an EXISTING install is NOT automatic: schema.sql uses
// `CREATE TABLE IF NOT EXISTS`, so on a pre-existing DB the DDL is a no-op and the on-disk vector(N) columns
// keep their ORIGINAL dimension — every later read/write would then fail with a cryptic pgvector "different
// dimensions" error (a 500-storm). Detect that mismatch at boot and fail fast with an actionable message.
export async function assertEmbeddingDim(sql: DB, dim: number): Promise<void> {
  const onDisk = async (table: string, col: string): Promise<number | null> => {
    const rows = await sql`SELECT format_type(atttypid, atttypmod) AS t
      FROM pg_attribute WHERE attrelid = ${table}::regclass AND attname = ${col} AND NOT attisdropped`;
    const m = rows[0]?.t ? /vector\((\d+)\)/.exec(rows[0].t as string) : null;
    return m ? Number(m[1]) : null;
  };
  for (const [table, col] of [["memory_entry", "memory_embedding"], ["chunk", "embedding"]] as const) {
    const found = await onDisk(table, col);
    if (found !== null && found !== dim) {
      throw new Error(
        `on-disk embedding dimension is ${found} but EMBED_DIM=${dim}. Switching the embedding model's ` +
          `dimension is NOT automatic — the existing tables keep their original dimension. To change it, ` +
          `delete the data dir (${dbDir()}) to recreate the tables at ${dim}-d, or migrate/re-embed explicitly.`,
      );
    }
  }
}

// --- single-writer lock -------------------------------------------------------------------------------
// PGlite has NO cross-process lock: two processes opening the same on-disk data dir run two independent
// Postgres engines with separate buffer pools, silently diverge, and lose committed rows (or corrupt the
// store) — a direct durability-pillar violation. Guard the embedded path with a PID-liveness lockfile kept
// OUTSIDE the PGDATA dir (initdb requires an EMPTY data dir). A live holder => refuse loudly; a dead/stale
// holder (crash) => reclaim. Fails SAFE: worst case is a false refusal that the user clears by deleting the
// named file — never silent corruption. (Dev `bun run --hot` re-opens in-process; that pre-existing caveat
// is unrelated — the real threat this closes is a SECOND process on the same dir.)
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // EPERM => the process exists but we can't signal it
  }
}

export function acquireDbLock(lockPath: string): () => void {
  const claim = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx"); // atomic O_CREAT|O_EXCL
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      return false;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (claim()) {
      const release = () => {
        try {
          if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
        } catch {}
      };
      process.once("exit", release);
      return release;
    }
    // Decide whether the existing lock is reclaimable — FAIL SAFE on anything ambiguous (a fail-open
    // reclaim here would re-introduce the exact double-writer this lock exists to prevent).
    let raw = "";
    try { raw = readFileSync(lockPath, "utf8").trim(); } catch {}
    const holder = Number(raw);
    const parseable = raw !== "" && Number.isInteger(holder) && holder > 0;
    if (parseable && holder !== process.pid && isAlive(holder)) {
      throw new Error(
        `the embedded database is already open by another Eunoia process (pid ${holder}); refusing to open ` +
          `a second writer (two engines on one data dir corrupt the store). Stop that process first, or set ` +
          `DATABASE_URL to use external Postgres. If no such process is running, delete ${lockPath}.`,
      );
    }
    if (!parseable) {
      // Empty/garbage lockfile — most likely a PEER that just created the file (the window between its
      // openSync and writeSync). Reclaiming would let two writers share one data dir, so refuse instead.
      // A genuinely stale empty file (a crash inside that microsecond window) is cleared by deleting it.
      throw new Error(
        `the embedded database lock at ${lockPath} appears held by another starting process; refusing to ` +
          `open a second writer. If no Eunoia process is running, delete ${lockPath}.`,
      );
    }
    // Reclaimable: our own pid (a dev hot reload) or a parseable, confirmed-dead pid (a crash). Clear + retry.
    try { rmSync(lockPath, { force: true }); } catch {}
  }
  throw new Error(`could not acquire the embedded database lock at ${lockPath}`);
}

// Bun standalone binary detection (same check embed.ts uses): import.meta.url lives in the bunfs.
const isStandalone = (): boolean =>
  import.meta.url.includes("$bunfs") || /%7ebun|~bun/i.test(import.meta.url);

// shared_buffers, auto-scaled to the device with a user override. Bounded [32,512] MB in ALL cases (the
// override is clamped too): 16 MB stalls initdb, and ~>2 GB aborts PGlite's WASM init; a memory server
// should stay small regardless. Auto default targets ~2% RAM capped at 128 MB. Override: EUNOIA_DB_SHARED_BUFFERS_MB.
function sharedBuffersMb(): number {
  const MIN = 32, MAX = 512;
  const raw = Number(process.env.EUNOIA_DB_SHARED_BUFFERS_MB);
  if (Number.isFinite(raw) && raw > 0) {
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(raw)));
    if (clamped !== Math.round(raw)) {
      console.warn(`[db] EUNOIA_DB_SHARED_BUFFERS_MB=${raw} out of range; clamped to ${clamped}MB (valid ${MIN}..${MAX}).`);
    }
    return clamped;
  }
  const totalMb = totalmem() / (1024 * 1024);
  return Math.min(128, Math.max(MIN, Math.round(totalMb * 0.02)));
}

function postgresqlconf(): string[] {
  const shared = sharedBuffersMb();
  // effective_cache_size is a PLANNER HINT (no allocation), so keep it comfortably above shared_buffers —
  // otherwise an overridden shared_buffers can exceed it and bias the planner toward seq scans.
  const effectiveCache = Math.max(192, shared * 3);
  return [
    `shared_buffers=${shared}MB`,
    "work_mem=2MB",
    "maintenance_work_mem=32MB",
    "max_connections=8",
    `effective_cache_size=${effectiveCache}MB`,
  ];
}

// In a compiled binary, extract vector.tar.gz to a real path and wrap the stock vector extension to
// override ONLY its bundlePath — its default `new URL("../vector.tar.gz", import.meta.url)` resolves inside
// the bunfs and can't be read. The tarball is tiny (~44 KB), so we rewrite it every boot: that is cheaper
// than a stale-copy bug from a size-only freshness check across binary upgrades, and the single-writer lock
// means no concurrent writer races us.
async function standaloneExtensions() {
  const tarPath = join(runtimeDir(), "vector.tar.gz");
  await Bun.write(tarPath, Bun.file(vectorTarUrl));
  return {
    vector: {
      name: vector.name,
      setup: async (pg: any, emOpts: any) => {
        const r = await vector.setup(pg, emOpts);
        return { ...r, bundlePath: pathToFileURL(tarPath) };
      },
    },
  };
}

async function makePglite(): Promise<DB> {
  // Single-writer guard (lockfile OUTSIDE the PGDATA dir so initdb still sees an empty data dir).
  const releaseLock = acquireDbLock(join(dataDir(), "db.lock"));
  try {
    // Default false = durable (crash-safe writes) — the trust pillar. Opt-in relax for write throughput.
    const relaxed =
      process.env.EUNOIA_DB_RELAXED_DURABILITY === "1" || process.env.EUNOIA_DB_RELAXED_DURABILITY === "true";

    const opts: Record<string, unknown> = {
      dataDir: dbDir(),
      relaxedDurability: relaxed,
      postgresqlconf: postgresqlconf(),
      extensions: { vector },
    };

    if (isStandalone()) {
      opts.pgliteWasmModule = await WebAssembly.compile(await Bun.file(pgliteWasmUrl).arrayBuffer());
      opts.initdbWasmModule = await WebAssembly.compile(await Bun.file(initdbWasmUrl).arrayBuffer());
      opts.fsBundle = new Blob([await Bun.file(pgliteDataUrl).arrayBuffer()]);
      opts.extensions = await standaloneExtensions();
    }

    const pg = await PGlite.create(opts as any);
    return makePgliteSql(pg);
  } catch (e) {
    releaseLock(); // never leave a lock behind if the DB failed to open
    throw e;
  }
}

export async function makeDb(): Promise<DB> {
  const schema = schemaForDim(EMBED_DIM);
  const url = process.env.DATABASE_URL;
  const sql = url
    ? (postgres(url, { max: 10, onnotice: () => {} }) as unknown as DB) // advanced override: external Postgres
    : await makePglite();
  try {
    await sql.unsafe(schema); // idempotent schema apply at boot (Spec 01)
    await assertEmbeddingDim(sql, EMBED_DIM); // fail fast on a model/dimension switch (no silent 500-storm)
    return sql;
  } catch (e) {
    try { await sql.end({}); } catch {}
    throw e;
  }
}
