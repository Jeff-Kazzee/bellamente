// eval-e2e.test.ts - command-level retrieval benchmark contract for P1.1.
// The harness must exercise the HTTP app routes, not direct search helpers.
import { test, expect } from "bun:test";
import {
  createEvalDataset,
  exactVsRouteDelta,
  evalEmbed,
  formatMetricsTable,
  percentile,
  runEvalCli,
  runEvalE2E,
  scoreRanking,
  type EvalReport,
} from "../scripts/eval-e2e";
import { EMBED_DIM } from "../src/embed-common";

const TEST_TIMEOUT_MS = 30000;

test("P1.1 fixture generation is reproducible for the same seed", () => {
  const a = createEvalDataset({ seed: 20260702 });
  const b = createEvalDataset({ seed: 20260702 });
  expect(a).toEqual(b);
  expect(a.queries.length).toBeGreaterThanOrEqual(100);
  expect(new Set(a.queries.map((q) => q.id)).size).toBe(a.queries.length);
});
test("P1.1 deterministic embedder has a stable non-zero fallback for empty input", async () => {
  const [vector] = await evalEmbed({ values: ["   "] });
  expect(vector).toHaveLength(EMBED_DIM);
  expect(vector[0]).toBe(1);
  expect(vector.slice(1).every((x) => x === 0)).toBe(true);
});
test("P1.1 metric helpers compute hand-checked recall, MRR, and percentiles", () => {
  const gold = new Set(["memory:target"]);

  expect(scoreRanking(["memory:target", "memory:decoy"], gold)).toEqual({
    r1: 1,
    r5: 1,
    r10: 1,
    reciprocalRank: 1,
  });
  expect(scoreRanking(["memory:a", "memory:b", "memory:target"], gold)).toEqual({
    r1: 0,
    r5: 1,
    r10: 1,
    reciprocalRank: 1 / 3,
  });
  expect(scoreRanking(["memory:a", "memory:b", "memory:c", "memory:d", "memory:e", "memory:target"], gold)).toEqual({
    r1: 0,
    r5: 0,
    r10: 1,
    reciprocalRank: 1 / 6,
  });
  expect(scoreRanking(["memory:a"], gold)).toEqual({ r1: 0, r5: 0, r10: 0, reciprocalRank: 0 });

  expect(percentile([30, 10, 20, 40], 50)).toBe(20);
  expect(percentile([30, 10, 20, 40], 95)).toBe(40);
  expect(percentile([], 95)).toBe(0);
  expect(exactVsRouteDelta(0.5, 0.75)).toBeCloseTo(0.25, 6);
  expect(exactVsRouteDelta(0.75, 0.5)).toBeCloseTo(0.25, 6);
  expect(exactVsRouteDelta(0.5, 0.5)).toBe(0);
});

test("P1.1 table labels the vector comparison as exact-vs-route delta, not ANN loss", () => {
  const row = {
    searchMode: "memories" as const,
    queryCount: 1,
    recallAt1: 1,
    recallAt5: 1,
    recallAt10: 1,
    mrr: 1,
    latencyP50Ms: 2,
    latencyP95Ms: 3,
    indexedVectorRecallAt10: 0.75,
    bruteForceRecallAt10: 0.5,
    exactVsRouteDeltaAt10: 0.25,
  };
  const report: EvalReport = {
    generatedAt: "2026-07-03T00:00:00.000Z",
    dataset: { seed: 20260702, containerTag: "eval-20260702", memoryCount: 1, documentCount: 1, queryCount: 3, embedder: "deterministic-hash" },
    routeCounts: {},
    modes: { memories: row, documents: { ...row, searchMode: "documents" }, hybrid: { ...row, searchMode: "hybrid" } },
  };

  const table = formatMetricsTable(report);
  expect(table).toContain("exact-vs-route delta@10");
  expect(table).toContain("25.0%");
  expect(table).not.toContain("ANN loss@10");
});

test("P1.1 fixture loading fails fast with the route that rejected the payload", async () => {
  const dataset = createEvalDataset({ seed: 20260702 });
  dataset.memories = [{ ...dataset.memories[0]!, content: "" }, ...dataset.memories.slice(1)];
  await expect(runEvalE2E({ dataset, quiet: true })).rejects.toThrow(/POST \/memories \/memories failed/);
}, TEST_TIMEOUT_MS);

test("P1.1 CLI runner defaults to deterministic mode and can opt into injected active embedder", async () => {
  const calls: Array<Parameters<typeof runEvalE2E>[0] | undefined> = [];
  const run = async (opts?: Parameters<typeof runEvalE2E>[0]) => {
    calls.push(opts);
  };

  await runEvalCli({ env: {}, run });
  expect(calls).toEqual([undefined]);

  let prewarmed = false;
  await runEvalCli({
    env: { BELLA_EVAL_REAL_EMBED: "1" },
    loadEmbedModule: async () => ({
      makeEmbed: () => evalEmbed,
      prewarmEmbed: async (embed) => {
        expect(embed).toBe(evalEmbed);
        prewarmed = true;
      },
    }),
    run,
  });

  expect(prewarmed).toBe(true);
  expect(calls[1]?.embed).toBe(evalEmbed);
  expect(calls[1]?.embedder?.startsWith("active:")).toBe(true);
});

test("P1.1 bench harness loads fixtures through HTTP routes and reports comparable retrieval metrics", async () => {
  const dataset = createEvalDataset({ seed: 20260702 });
  expect(dataset.queries.length).toBeGreaterThanOrEqual(100);
  expect(dataset.queries.some((q) => q.searchMode === "memories")).toBe(true);
  expect(dataset.queries.some((q) => q.searchMode === "documents")).toBe(true);
  expect(dataset.queries.some((q) => q.searchMode === "hybrid")).toBe(true);

  const report = await runEvalE2E({ dataset, quiet: true });
  expect(report.dataset.queryCount).toBe(dataset.queries.length);
  expect(report.routeCounts["POST /memories"]).toBeGreaterThan(0);
  expect(report.routeCounts["POST /documents"]).toBeGreaterThan(0);
  expect(report.routeCounts["GET /documents/:id"]).toBeGreaterThan(0);
  expect(report.routeCounts["POST /search"]).toBeGreaterThanOrEqual(dataset.queries.length);

  for (const mode of ["memories", "documents", "hybrid"] as const) {
    const row = report.modes[mode];
    expect(row.queryCount).toBeGreaterThan(0);
    expect(row.recallAt1).toBeGreaterThanOrEqual(0);
    expect(row.recallAt5).toBeGreaterThanOrEqual(row.recallAt1);
    expect(row.recallAt10).toBeGreaterThanOrEqual(row.recallAt5);
    expect(row.mrr).toBeGreaterThanOrEqual(0);
    expect(row.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(row.latencyP95Ms).toBeGreaterThanOrEqual(row.latencyP50Ms);
    expect(row.indexedVectorRecallAt10).toBeGreaterThanOrEqual(0);
    expect(row.bruteForceRecallAt10).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(row.exactVsRouteDeltaAt10)).toBe(true);
  }

  expect(report.modes.memories.exactVsRouteDeltaAt10).toBe(0);
  expect(report.modes.documents.exactVsRouteDeltaAt10).toBe(0);
  expect(report.modes.hybrid.exactVsRouteDeltaAt10).toBe(0);


  expect(report.modes.memories.recallAt1).toBeCloseTo(0.8409, 4);
  expect(report.modes.memories.recallAt10).toBe(1);
  expect(report.modes.memories.mrr).toBeCloseTo(0.9205, 4);
  expect(report.modes.documents.recallAt1).toBe(1);
  expect(report.modes.documents.recallAt10).toBe(1);
  expect(report.modes.documents.mrr).toBe(1);
  expect(report.modes.hybrid.recallAt1).toBe(1);
  expect(report.modes.hybrid.recallAt10).toBe(1);
  expect(report.modes.hybrid.mrr).toBe(1);
  const table = formatMetricsTable(report);
  expect(table).toContain("recall@1");
  expect(table).toContain("recall@5");
  expect(table).toContain("recall@10");
  expect(table).toContain("MRR");
  expect(table).toContain("p50");
  expect(table).toContain("p95");
  expect(table).toContain("exact-vs-route delta@10");
}, TEST_TIMEOUT_MS);
