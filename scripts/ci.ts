// scripts/ci.ts — Bellamente LOCAL CI. GitHub Actions is intentionally disabled on this repo
// (local-first should mean no cloud dependency for *quality* either), so quality runs here. `bun run ci`
// runs the four AGENTS.md gates and enforces the GLOBAL coverage floor. Usage: `bun run ci`.
//
// Coverage (issue #96): bun's bunfig `coverageThreshold` is enforced PER FILE, so integration-only
// files (embed.ts worker dispatch, index.ts Bun.serve boot, db.ts lock/crash paths) trip it and
// `bun test` exits 1 even when the suite is green and GLOBAL coverage clears the intended floor. The
// ratchet has always measured the GLOBAL number, so that is what we enforce: bunfig emits an lcov
// report (coverage/lcov.info) and we compute the global funcs/lines % from it and fail below the floor.
// This enforces a real metric from a machine-readable file — it does NOT scrape stdout to read around
// an exit code. Every gate below is judged by its real exit code.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

// GLOBAL coverage floor, WEIGHTED (total covered / total found — the real "% covered", NOT bun's
// unweighted per-file mean). RATCHET: raise as gaps fill (target 1.0); never lower. Re-baselined
// 2026-07-05: the old bunfig 0.91 lines was bun's unweighted-mean "All files" figure; on the weighted
// metric current coverage is funcs 92.71 / lines 90.18, so the honest floor is 0.90/0.90 — a metric
// correction, not a lowering. Integration-only files (embed/index/db) are covered by dogfood, not units.
const FLOOR = { functions: 0.9, lines: 0.9 };

type Gate = { name: string; cmd: string };
const gates: Gate[] = [
  { name: "whitespace (git diff --check)", cmd: "git diff --check" },
  { name: "typecheck (tsc --noEmit)", cmd: "bunx tsc --noEmit" },
  { name: "tests (bun test)", cmd: "bun test" }, // bunfig writes coverage/lcov.info for the floor check
  { name: "build (bun run build)", cmd: "bun run build" },
];

const results: string[] = [];
let ok = true;

rmSync("coverage", { recursive: true, force: true }); // stale lcov must never satisfy the floor check

for (const g of gates) {
  process.stdout.write(`\n=== ${g.name} ===\n`);
  const r = spawnSync(g.cmd, { encoding: "utf8", shell: true });
  process.stdout.write((r.stdout ?? "") + (r.stderr ?? ""));
  const passed = r.status === 0; // real exit code — no summary scraping
  results.push(`${passed ? "PASS" : "FAIL"}  ${g.name}`);
  if (!passed) ok = false;
}

// GLOBAL coverage floor, computed from the lcov the test gate just wrote. Fail-closed if it is missing
// or unreadable (a green suite with no coverage report must NOT pass silently).
process.stdout.write(`\n=== coverage (global floor: funcs ${FLOOR.functions}, lines ${FLOOR.lines}) ===\n`);
try {
  const lcov = readFileSync("coverage/lcov.info", "utf8");
  let fnFound = 0, fnHit = 0, lnFound = 0, lnHit = 0;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("FNF:")) fnFound += Number(line.slice(4));
    else if (line.startsWith("FNH:")) fnHit += Number(line.slice(4));
    else if (line.startsWith("LF:")) lnFound += Number(line.slice(3));
    else if (line.startsWith("LH:")) lnHit += Number(line.slice(3));
  }
  if (fnFound === 0 || lnFound === 0) throw new Error("lcov reported zero functions or lines — nothing was measured");
  const fnPct = fnHit / fnFound;
  const lnPct = lnHit / lnFound;
  const fnOk = fnPct >= FLOOR.functions;
  const lnOk = lnPct >= FLOOR.lines;
  process.stdout.write(`functions ${(fnPct * 100).toFixed(2)}% (${fnHit}/${fnFound}) — ${fnOk ? "PASS" : "FAIL"}\n`);
  process.stdout.write(`lines     ${(lnPct * 100).toFixed(2)}% (${lnHit}/${lnFound}) — ${lnOk ? "PASS" : "FAIL"}\n`);
  const covOk = fnOk && lnOk;
  results.push(`${covOk ? "PASS" : "FAIL"}  coverage (global floor)`);
  if (!covOk) ok = false;
} catch (e) {
  process.stdout.write(`coverage FAILED to read coverage/lcov.info: ${e instanceof Error ? e.message : String(e)}\n`);
  results.push("FAIL  coverage (global floor) — lcov missing/unreadable");
  ok = false;
}

process.stdout.write(`\n===== LOCAL CI =====\n${results.join("\n")}\n${ok ? "✅ ALL GATES PASS" : "❌ GATES FAILED"}\n`);
process.exit(ok ? 0 : 1);
