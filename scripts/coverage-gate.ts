// Pure lcov coverage-gate evaluation — extracted from test-with-coverage-gate.ts so it can be
// unit-tested. The gate is a CRITICAL merge signal: a false PASS lets zero-/low-coverage code merge.
// Historically `pct = found === 0 ? 1 : hit/found` read an all-zero lcov as 100% and passed the gate on
// ZERO coverage (#126). This module FAILS CLOSED on a degenerate or partial-instrumentation report.

export const FLOORS = { functions: 0.9, lines: 0.91 } as const;

// Instrumentation sanity floor: a healthy run instruments the whole loaded src tree (~30 files). If lcov
// comes back with far fewer, instrumentation silently broke (a path/config regression) and the ratio
// would read green on a near-empty denominator. Require a real body of instrumented files. (#126)
export const MIN_INSTRUMENTED_FILES = 20;

export type Floors = { readonly functions: number; readonly lines: number };

export type CoverageResult = {
  pass: boolean;
  failures: string[];
  summary: string;
  filesInstrumented: number;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

export function evaluateCoverage(lcovText: string, floors: Floors, minFiles: number): CoverageResult {
  let filesInstrumented = 0;
  let linesFound = 0, linesHit = 0, functionsFound = 0, functionsHit = 0;
  for (const line of lcovText.split(/\r?\n/)) {
    if (line.startsWith("SF:")) { filesInstrumented++; continue; } // path may contain ':' (Windows) — count, don't split
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const value = Number(line.slice(idx + 1));
    if (!Number.isFinite(value)) continue;
    const key = line.slice(0, idx);
    if (key === "LF") linesFound += value;
    else if (key === "LH") linesHit += value;
    else if (key === "FNF") functionsFound += value;
    else if (key === "FNH") functionsHit += value;
  }

  const ratio = (hit: number, found: number) => (found === 0 ? 0 : hit / found); // 0, never a false 100% on empty
  const lines = ratio(linesHit, linesFound);
  const functions = ratio(functionsHit, functionsFound);
  const fmt = (n: number) => `${(n * 100).toFixed(2)}%`;

  const failures: string[] = [];
  // Fail CLOSED on a degenerate/partial report BEFORE trusting the ratio: an all-zero or nearly-empty
  // lcov means instrumentation did not run, NOT that everything is covered.
  if (linesFound === 0 || functionsFound === 0) {
    failures.push(`degenerate coverage report (linesFound=${linesFound}, functionsFound=${functionsFound}) — instrumentation did not run`);
  } else if (filesInstrumented < minFiles) {
    failures.push(`only ${filesInstrumented} files instrumented (< ${minFiles} expected) — partial instrumentation loss`);
  } else {
    if (lines < floors.lines) failures.push(`lines ${fmt(lines)} < ${fmt(floors.lines)}`);
    if (functions < floors.functions) failures.push(`functions ${fmt(functions)} < ${fmt(floors.functions)}`);
  }

  const summary =
    `[coverage] ${filesInstrumented} files instrumented; ` +
    `lines ${linesHit}/${linesFound} ${fmt(lines)} (floor ${fmt(floors.lines)}); ` +
    `functions ${functionsHit}/${functionsFound} ${fmt(functions)} (floor ${fmt(floors.functions)})`;

  return { pass: failures.length === 0, failures, summary, filesInstrumented, linesFound, linesHit, functionsFound, functionsHit };
}
