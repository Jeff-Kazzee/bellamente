// Runs the Bun test suite and enforces Bellamente's aggregate coverage ratchet.
//
// Bun 1.3.x applies bunfig `coverageThreshold` per file. That is stricter than this repo's policy:
// some boot/embed paths are intentionally proven by the release smoke instead of unit tests. Keep the
// aggregate floor here so `bun run test` remains the merge gate without lowering the ratchet.
//
// The lcov parse + pass/fail decision lives in ./coverage-gate.ts (pure, unit-tested in
// test/coverage-gate.test.ts) so this merge signal can't silently regress into a false PASS (#126).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { evaluateCoverage, FLOORS, MIN_INSTRUMENTED_FILES } from "./coverage-gate";

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

const result = evaluateCoverage(lcov, FLOORS, MIN_INSTRUMENTED_FILES);
console.log(result.summary);
if (!result.pass) {
  console.error(`[coverage] FAIL: ${result.failures.join("; ")}`);
  process.exit(1);
}
