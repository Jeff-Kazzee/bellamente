// doctor.ts - `eunoia doctor`: verify the install is ready and surface resource usage.
// A trust/visibility tool: it checks DB reachability, model presence, and storage footprint vs the
// optional disk budget. Read-only beyond ensuring the (already-safe) storage dirs exist.
import { statSync } from "node:fs";
import { join } from "node:path";
import { storageDirs, dirSizeBytes, diskUsedBytes, diskBudgetMb } from "./paths";
import { EMBED_DIM, LOCAL_MODEL, LOCAL_DTYPE, PROVIDER, onnxRelPath } from "./embed-common";

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
