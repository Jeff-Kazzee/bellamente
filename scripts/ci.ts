// scripts/ci.ts — Bellamente LOCAL CI. Runs the four gates in one command and judges `bun test`
// by its PRINTED SUMMARY, not the exit code (bun exits 1 under coverage even when all-green and
// floors are met — issue #96). GitHub Actions is intentionally disabled on this repo; quality runs
// here, locally, so there is no cloud dependency for CI. Usage: `bun run ci`.
import { spawnSync } from "node:child_process";

type Gate = { name: string; cmd: string; judge?: (out: string, code: number) => boolean };

const gates: Gate[] = [
  { name: "typecheck (tsc --noEmit)", cmd: "bunx tsc --noEmit" },
  {
    name: "tests (bun test)",
    cmd: "bun test",
    // #96: a green run still exits 1 under coverage. Trust the summary: "N pass" and "0 fail".
    judge: (out) => /(^|\s)0 fail(\s|$)/m.test(out) && /(^|\s)[1-9]\d* pass/m.test(out),
  },
  { name: "build (bun run build)", cmd: "bun run build" },
];

const results: string[] = [];
let ok = true;
for (const g of gates) {
  process.stdout.write(`\n=== ${g.name} ===\n`);
  const r = spawnSync(g.cmd, { encoding: "utf8", shell: true });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(out);
  const passed = g.judge ? g.judge(out, r.status ?? 1) : r.status === 0;
  results.push(`${passed ? "PASS" : "FAIL"}  ${g.name}`);
  if (!passed) ok = false;
}

process.stdout.write(`\n===== LOCAL CI =====\n${results.join("\n")}\n${ok ? "✅ ALL GATES PASS" : "❌ GATES FAILED"}\n`);
process.exit(ok ? 0 : 1);
