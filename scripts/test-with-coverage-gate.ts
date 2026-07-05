// Runs the Bun test suite and enforces Bellamente's aggregate coverage ratchet.
//
// Bun 1.3.x applies bunfig `coverageThreshold` per file. That is stricter than this repo's policy:
// some boot/embed paths are intentionally proven by the release smoke instead of unit tests. Keep the
// aggregate floor here so `bun run test` remains the merge gate without lowering the ratchet.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const FLOORS = {
  functions: 0.90,
  lines: 0.91,
} as const;

const coverageDir = join(process.cwd(), "coverage");
const lcovPath = join(coverageDir, "lcov.info");

if (existsSync(coverageDir)) rmSync(coverageDir, { recursive: true, force: true });

const test = Bun.spawn(["bun", "test", "--coverage-reporter=lcov"], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const testExit = await test.exited;
if (testExit !== 0) process.exit(testExit);

const lcov = await Bun.file(lcovPath).text().catch(() => {
  throw new Error(`missing coverage report at ${lcovPath}`);
});

const totals = { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };

for (const line of lcov.split(/\r?\n/)) {
  const [key, raw] = line.split(":");
  const value = Number(raw);
  if (!Number.isFinite(value)) continue;
  if (key === "LF") totals.linesFound += value;
  else if (key === "LH") totals.linesHit += value;
  else if (key === "FNF") totals.functionsFound += value;
  else if (key === "FNH") totals.functionsHit += value;
}

const pct = (hit: number, found: number) => (found === 0 ? 1 : hit / found);
const lines = pct(totals.linesHit, totals.linesFound);
const functions = pct(totals.functionsHit, totals.functionsFound);

const format = (n: number) => `${(n * 100).toFixed(2)}%`;

console.log(
  `[coverage] lines ${totals.linesHit}/${totals.linesFound} ${format(lines)} ` +
    `(floor ${format(FLOORS.lines)}); functions ${totals.functionsHit}/${totals.functionsFound} ` +
    `${format(functions)} (floor ${format(FLOORS.functions)})`,
);

const failures: string[] = [];
if (lines < FLOORS.lines) failures.push(`lines ${format(lines)} < ${format(FLOORS.lines)}`);
if (functions < FLOORS.functions) failures.push(`functions ${format(functions)} < ${format(FLOORS.functions)}`);

if (failures.length > 0) {
  console.error(`[coverage] FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
