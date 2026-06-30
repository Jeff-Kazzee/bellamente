// doctor.ts - `eunoia doctor`: verify the install is ready and surface resource usage.
// A trust/visibility tool: it checks DB reachability, model presence, and storage footprint vs the
// optional disk budget. Read-only beyond ensuring the (already-safe) storage dirs exist.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { storageDirs, dirSizeBytes, diskUsedBytes, diskBudgetMb } from "./paths";
import { EMBED_DIM, LOCAL_MODEL, LOCAL_DTYPE, PROVIDER } from "./embed-common";

const MB = 1024 * 1024;
const mb = (bytes: number) => (bytes / MB).toFixed(1) + " MB";

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
      `  onnxThreads=${process.env.EUNOIA_ONNX_THREADS ?? 1}  port=${process.env.PORT ?? 8080}`,
  );
  console.log("");

  console.log("Checks:");

  // Model present? (local provider only.) Honor EUNOIA_MODEL_DIR exactly like the embed worker.
  if (PROVIDER === "local") {
    const modelBase = process.env.EUNOIA_MODEL_DIR ?? dirs.models;
    const modelPath = join(modelBase, ...LOCAL_MODEL.split("/"));
    const present = existsSync(modelPath);
    check(present, `model cached: ${LOCAL_MODEL}`, present ? modelPath : "not yet downloaded (fetched on first run)");
  }

  // Disk budget.
  const used = diskUsedBytes();
  const budget = diskBudgetMb();
  if (budget > 0) {
    check(used <= budget * MB, "disk within budget", `${mb(used)} used / ${budget} MB budget`);
  } else {
    console.log(`  -- disk used (data+cache): ${mb(used)}  (set EUNOIA_DISK_BUDGET_MB to enforce a cap)`);
  }

  // DB reachable?
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("  -- DATABASE_URL not set (embedded PGlite DB is the follow-on; set it for external Postgres)");
  } else {
    try {
      const { makeDb } = await import("./db");
      const sql = await makeDb();
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      check(true, "database reachable", url.replace(/:\/\/[^@]*@/, "://***@"));
    } catch (e: any) {
      check(false, "database reachable", String(e?.message ?? e));
    }
  }

  console.log("");
  console.log(problems === 0 ? "All checks passed." : `${problems} problem(s) found.`);
  return problems === 0 ? 0 : 1;
}
