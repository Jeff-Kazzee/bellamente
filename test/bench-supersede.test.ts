// Contract test for the supersede benchmark. Drives the WHOLE pipeline (sim → sweep → separability)
// with a synthetic embedder so the math + cascade are pinned deterministically, no network. Vectors
// live in orthogonal subspaces (cross-group cosine = 0) with hand-chosen intra-group cosines.
import { expect, test, describe } from "bun:test";
import { simulate, separability, sweep, marginSweep, run, factId, cos, type Write } from "../scripts/bench-supersede";
import type { Embed } from "../src/embed";

// 6-d unit vectors. Group A (correction) in dims 0-1; group N (distinct nodes) in dims 2-3; U in dims 4-5.
//  A_orig·A_upd = 0.96   N1·N2 = 0.97   N2·N3 = 0.97   N1·N3 = 0.8817   all cross-group = 0
const A_ORIG = [1, 0, 0, 0, 0, 0];
const A_UPD = [0.96, 0.2799, 0, 0, 0, 0];
const N1 = [0, 0, 1, 0, 0, 0];
const N2 = [0, 0, 0.97, 0.2431, 0, 0];
const N3 = [0, 0, 0.8817, 0.4718, 0, 0];
const U = [0, 0, 0, 0, 1, 0];

const WRITES: Write[] = [
  { group: "A", role: "original", kind: "correction", text: "a1" },
  { group: "A", role: "update", kind: "correction", text: "a2" },
  { group: "N", role: "original", kind: "distinct", text: "n1" },
  { group: "N", role: "original", kind: "distinct", text: "n2" },
  { group: "N", role: "original", kind: "distinct", text: "n3" },
  { group: "U", role: "original", kind: "unrelated", text: "u" },
];
const VECS = [A_ORIG, A_UPD, N1, N2, N3, U];

describe("bench-supersede pure math", () => {
  test("cosine == dot for unit vectors; the hand-chosen cosines hold", () => {
    expect(cos(A_ORIG, A_UPD)).toBeCloseTo(0.96, 4);
    expect(cos(N1, N2)).toBeCloseTo(0.97, 4);
    expect(cos(N2, N3)).toBeCloseTo(0.97, 3); // hand-typed components round to 0.96996
    expect(cos(N1, N3)).toBeCloseTo(0.8817, 3);
    expect(cos(A_ORIG, N1)).toBe(0); // orthogonal subspaces
  });

  test("factId: a correction group is one fact; distinct/unrelated are per-write", () => {
    expect(factId(WRITES[0]!, 0)).toBe(factId(WRITES[1]!, 1)); // A_orig & A_upd == one fact
    expect(factId(WRITES[2]!, 2)).not.toBe(factId(WRITES[3]!, 3)); // each node its own fact
    // ideal survivors = distinct facts = corr:A + 3 nodes + U = 5
    expect(new Set(WRITES.map((w, i) => factId(w, i))).size).toBe(5);
  });

  test("τ=0.95: correction merges, node cascade over-merges (the flagged failure)", () => {
    const r = simulate(WRITES, VECS, 0.95);
    expect(r.slots.length).toBe(3); // A(0,1) · N(2,3,4) · U(5)
    expect(r.correctCollapses).toBe(1); // A_upd onto A_orig
    expect(r.falseCollapses).toBe(2); // N2 then N3 cascade onto the node slot
    expect(r.missedCorrections).toBe(0);
    expect(r.lostFacts).toBe(2); // 3 distinct nodes folded into 1 slot ⇒ 2 lost
    expect(r.splitCorrectionFacts).toBe(0);
    expect(r.survivorsPerGroup["N"]).toBe(1); // 8-of-3-style collapse: only 1 node survives
    expect(r.survivorsPerGroup["A"]).toBe(1);
  });

  test("τ=0.98: nothing merges — correction is MISSED, distinct facts preserved", () => {
    const r = simulate(WRITES, VECS, 0.98);
    expect(r.slots.length).toBe(6); // every write its own slot
    expect(r.correctCollapses).toBe(0);
    expect(r.falseCollapses).toBe(0);
    expect(r.missedCorrections).toBe(1); // A_upd (0.96) fails the 0.98 bar
    expect(r.lostFacts).toBe(0); // no over-merge
    expect(r.splitCorrectionFacts).toBe(1); // corr:A spread across 2 slots
  });

  test("margin rule blocks the cascade: node2/3 have a near-tie neighbor, correction does not", () => {
    // With margin, a collapse also needs nearest − second_nearest >= margin. In this fixture the node
    // slot only ever has ONE node member at a time (they chain), so second-nearest is ~0 and margin
    // passes — margin does NOT help a linear chain. This asserts the margin PLUMBING, not efficacy.
    const r = simulate(WRITES, VECS, 0.95, 0.5);
    expect(r.correctCollapses).toBe(1); // A_upd still merges (second-nearest ≈ 0, margin 0.96 ≥ 0.5)
  });

  test("separability: the two populations OVERLAP (no clean scalar)", () => {
    const s = separability(WRITES, VECS);
    expect(s.shouldMerge).toEqual([expect.closeTo(0.96, 4)]);
    expect(s.mergeMin).toBeCloseTo(0.96, 4);
    expect(s.confuseMax).toBeCloseTo(0.97, 4); // node siblings sit above the correction pair
    expect(s.overlap).toBe(true); // 0.96 (min merge) < 0.97 (max confuser)
    expect(s.confusersAbove95).toBe(2); // exact pairs: N1-N2 and N2-N3 (N1-N3 = 0.88 is below)
  });

  test("sweep: over-merge falls and misses rise as τ climbs (the tradeoff is monotone here)", () => {
    const rows = sweep(WRITES, VECS, [0.95, 0.98]);
    expect(rows[0]!.lostFacts).toBe(2); // 0.95 loses node facts
    expect(rows[1]!.lostFacts).toBe(0); // 0.98 loses none...
    expect(rows[1]!.missedCorrections).toBe(1); // ...but misses the correction
    expect(rows[0]!.idealSurvivors).toBe(5);
  });

  test("marginSweep: a margin does NOT stop a linear cascade (second-nearest ≈ 0 each step)", () => {
    const rows = marginSweep(WRITES, VECS, 0.95, [0, 0.1, 0.5]);
    // node cascade absorbs each clone before the next arrives, so margin never trips on it
    expect(rows.every((r) => r.falseCollapses === 2)).toBe(true);
    expect(rows[0]!.correctCollapses).toBe(1); // A_upd still merges at margin 0
  });

  test("run() drives the whole pipeline + renders the report (covers formatReport)", async () => {
    const LOOKUP: Record<string, number[]> = { a1: A_ORIG, a2: A_UPD, n1: N1, n2: N2, n3: N3, u: U };
    const fakeEmbed: Embed = async ({ values }) => values.map((t) => LOOKUP[t]!);
    const { report, sep, rows, at95, dim } = await run(fakeEmbed, WRITES, [0.95, 0.98]);
    expect(dim).toBe(6);
    expect(sep.overlap).toBe(true);
    expect(at95.lostFacts).toBe(2);
    expect(rows).toHaveLength(2);
    expect(report).toContain("Supersede-threshold benchmark");
    expect(report).toContain("Overlap: YES");
    expect(report).toContain("Where does the over-merge land?");
    expect(report).toContain("| N | 3 | 1 | 2 |"); // per-group table: node-like group loses 2 of 3
  });

  test("separability surfaces WHICH pairs are ≥0.95 (to see if damage is concentrated)", () => {
    const s = separability(WRITES, VECS);
    expect(s.confuserPairs).toHaveLength(2); // N1-N2, N2-N3
    expect(s.confuserPairs.every((p) => p.sim >= 0.95)).toBe(true);
    expect(s.confuserPairs[0]!.sim).toBeGreaterThanOrEqual(s.confuserPairs[1]!.sim); // sorted desc
  });
});
