// eval-e2e.test.ts - command-level retrieval benchmark contract for P1.1.
// The harness must exercise the HTTP app routes, not direct search helpers.
import { test, expect } from "bun:test";
import { createEvalDataset, evalEmbed, formatMetricsTable, runEvalCli, runEvalE2E } from "../scripts/eval-e2e";

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
  expect(vector).toHaveLength(384);
  expect(vector[0]).toBe(1);
  expect(vector.slice(1).every((x) => x === 0)).toBe(true);
});

test("P1.1 fixture loading fails fast with the route that rejected the payload", async () => {
  const dataset = createEvalDataset({ seed: 20260702 });
  dataset.memories = [{ ...dataset.memories[0]!, content: "" }, ...dataset.memories.slice(1)];
  await expect(runEvalE2E({ dataset, quiet: true })).rejects.toThrow(/POST \/memories \/memories failed/);
}, TEST_TIMEOUT_MS);

test("P1.1 CLI runner defaults to deterministic mode and can opt into injected active embedder", async () => {
  const calls: Array<unknown> = [];
  const run = async (opts?: Parameters<typeof runEvalE2E>[0]) => {
    calls.push(opts);
    return {} as Awaited<ReturnType<typeof runEvalE2E>>;
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
  expect((calls[1] as { embed?: unknown }).embed).toBe(evalEmbed);
  expect((calls[1] as { embedder?: string }).embedder?.startsWith("active:")).toBe(true);
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
    expect(Number.isFinite(row.annLossAt10)).toBe(true);
  }

  const table = formatMetricsTable(report);
  expect(table).toContain("recall@1");
  expect(table).toContain("recall@5");
  expect(table).toContain("recall@10");
  expect(table).toContain("MRR");
  expect(table).toContain("p50");
  expect(table).toContain("p95");
  expect(table).toContain("ANN loss@10");
}, TEST_TIMEOUT_MS);
