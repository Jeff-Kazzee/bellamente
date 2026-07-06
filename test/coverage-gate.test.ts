// Behavior tests for the coverage gate's decision logic (#126). The gate is a merge signal, so a false
// PASS here is exactly the failure this suite guards against.
import { test, expect } from "bun:test";
import { evaluateCoverage, FLOORS } from "../scripts/coverage-gate";

function lcov(files: { lf: number; lh: number; fnf: number; fnh: number }[]): string {
  return files
    .map((f, i) => `SF:src/file${i}.ts\nFNF:${f.fnf}\nFNH:${f.fnh}\nLF:${f.lf}\nLH:${f.lh}\nend_of_record`)
    .join("\n");
}
const many = (n: number, f: { lf: number; lh: number; fnf: number; fnh: number }) => Array.from({ length: n }, () => f);

test("healthy coverage above the floors passes", () => {
  const r = evaluateCoverage(lcov(many(25, { lf: 100, lh: 95, fnf: 20, fnh: 19 })), FLOORS, 20);
  expect(r.pass).toBe(true);
  expect(r.filesInstrumented).toBe(25);
});

test("all-zero lcov FAILS instead of reading 100% (the #126 false-pass)", () => {
  // Files present but every counter is 0 — the old `found===0 ? 1` read this as 100% and passed the gate.
  const r = evaluateCoverage(lcov(many(25, { lf: 0, lh: 0, fnf: 0, fnh: 0 })), FLOORS, 20);
  expect(r.pass).toBe(false);
  expect(r.failures.join(" ")).toContain("degenerate");
});

test("an empty lcov (no files at all) FAILS", () => {
  const r = evaluateCoverage("", FLOORS, 20);
  expect(r.pass).toBe(false);
});

test("partial instrumentation loss (few files, each 100%) FAILS the min-files floor", () => {
  // Ratio looks perfect, but most of the tree was not instrumented — must not pass.
  const r = evaluateCoverage(lcov(many(3, { lf: 100, lh: 100, fnf: 20, fnh: 20 })), FLOORS, 20);
  expect(r.pass).toBe(false);
  expect(r.failures.join(" ")).toContain("instrument");
});

test("genuine coverage below the line floor FAILS", () => {
  const r = evaluateCoverage(lcov(many(25, { lf: 100, lh: 80, fnf: 20, fnh: 20 })), FLOORS, 20); // 80% lines < 91%
  expect(r.pass).toBe(false);
  expect(r.failures.join(" ")).toContain("lines");
});

test("Windows SF paths with a drive-letter colon are counted correctly", () => {
  const body = "SF:C:\\repo\\src\\a.ts\nFNF:10\nFNH:10\nLF:50\nLH:50\nend_of_record";
  const r = evaluateCoverage(body, FLOORS, 1);
  expect(r.filesInstrumented).toBe(1);
  expect(r.linesFound).toBe(50);
});
