// doctor.ts - `eunoia doctor`: verify the install is ready and surface resource usage.
// A trust/visibility tool: it checks DB reachability, model presence, and storage footprint vs the
// optional disk budget. Read-only beyond ensuring the (already-safe) storage dirs exist.
import { statSync } from "node:fs";
import { join } from "node:path";
import { storageDirs, dirSizeBytes, diskUsedBytes, diskBudgetMb } from "./paths";
import { EMBED_DIM, LOCAL_MODEL, LOCAL_DTYPE, PROVIDER, onnxRelPath } from "./embed-common";

const MB = 1024 * 1024;
const mb = (bytes: number) => (bytes / MB).toFixed(1) + " MB";

// Redact the password in a DATABASE_URL for display. Uses the URL API, which correctly handles an
// unencoded '@' inside the password (a naive first-'@' regex would print the password's tail).
function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    if (x.password) x.password = "***";
    return x.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

// Is an EUNOIA server already running (and thus holding the embedded DB's single-writer lock)? Requires the
// `service: "eunoia"` tag so an unrelated process answering 200 on the same port can't produce a false OK.
async function serverIsUp(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { service?: string };
    return body?.service === "eunoia";
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<number> {
  let problems = 0;
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`  ${ok ? "OK " : "XX "} ${label}${detail ? "  — " + detail : ""}`);
    if (!ok) problems++;
  };

  console.log("Eunoia doctor\n");

  // Storage layout + per-dir footprint.
  const dirs = storageDirs();
  console.log("Storage:");
  for (const [k, d] of Object.entries(dirs)) {
    console.log(`  ${k.padEnd(8)} ${d}  (${mb(dirSizeBytes(d))})`);
  }
  console.log("");

  // Config snapshot.
  console.log("Config:");
  console.log(
    `  provider=${PROVIDER}  model=${LOCAL_MODEL}  dtype=${LOCAL_DTYPE}  dim=${EMBED_DIM}` +
      `  wasmThreads=1  port=${process.env.PORT ?? 8080}`,
  );
  console.log("");

  console.log("Checks:");

  // Model present? (local provider only.) Check the actual .onnx WEIGHTS file (not just the model dir —
  // the tokenizer files are downloaded separately, so a dir-only check would falsely report "cached").
  // Honor EUNOIA_MODEL_DIR exactly like the embed engine.
  if (PROVIDER === "local") {
    const modelBase = process.env.EUNOIA_MODEL_DIR ?? dirs.models;
    const weights = join(modelBase, ...onnxRelPath());
    let present = false;
    try { present = statSync(weights).size > 0; } catch {}
    check(present, `model weights cached: ${LOCAL_MODEL}`, present ? weights : "not yet downloaded (fetched on first run)");
  }

  // Disk budget.
  const used = diskUsedBytes();
  const budget = diskBudgetMb();
  if (budget > 0) {
    check(used <= budget * MB, "disk within budget", `${mb(used)} used / ${budget} MB budget`);
  } else {
    console.log(`  -- disk used (data+cache): ${mb(used)}  (set EUNOIA_DISK_BUDGET_MB to enforce a cap)`);
  }

  // DB check. Default = embedded PGlite; external Postgres when DATABASE_URL is set. Verify pgvector.
  // - External: a READ-ONLY probe — do NOT call makeDb() here, which would apply the full schema DDL to
  //   someone else's server (a "read-only" health check must not mutate).
  // - Embedded: if a server is already running it holds the single-writer lock, so opening a second engine
  //   is unsafe (and would be refused). Probe /health first; only open the DB directly when no server is up.
  const url = process.env.DATABASE_URL;
  const dbLabel = url ? "database reachable + pgvector" : "embedded database ready + pgvector";
  try {
    if (url) {
      const pg = (await import("postgres")).default;
      const sql = pg(url, { max: 1, onnotice: () => {} });
      try {
        await sql`select 1`;
        const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
        check(ext.length > 0, dbLabel, ext.length > 0 ? redactUrl(url) : "pgvector not installed");
      } finally {
        await sql.end({ timeout: 1 });
      }
    } else if (await serverIsUp(Number(process.env.PORT ?? 8080))) {
      // A running server holds the single-writer lock; doctor genuinely cannot probe the DB while it's held.
      // Report informationally (neither a pass nor a false OK) — the running server already verified it at boot.
      console.log(`  -- embedded database in use by a running Eunoia server on :${process.env.PORT ?? 8080} (not probed while locked)`);
    } else {
      const { makeDb, DB_LOCK_ERR } = await import("./db");
      try {
        const sql = await makeDb();
        try {
          const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
          check(ext.length > 0, dbLabel, ext.length > 0 ? "PGlite at " + dirs.db : "pgvector not installed");
        } finally {
          await sql.end({ timeout: 1 });
        }
      } catch (e: any) {
        // Another Eunoia process grabbed the lock between the /health probe and now — that's healthy, not a
        // problem; report it informationally rather than as a failed check.
        if (e?.code === DB_LOCK_ERR) {
          console.log(`  -- embedded database in use by another Eunoia process (not probed): ${e.message}`);
        } else {
          throw e;
        }
      }
    }
  } catch (e: any) {
    check(false, dbLabel, String(e?.message ?? e));
  }

  console.log("");
  console.log(problems === 0 ? "All checks passed." : `${problems} problem(s) found.`);
  return problems === 0 ? 0 : 1;
}
