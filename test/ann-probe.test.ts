// ann-probe.test.ts - P1.5 filtered-ANN probe contract.
// The probe must exercise production-shaped vector queries and emit evidence, not guesses.
import { test, expect } from "bun:test";
import { actualReturnedRows, classifyVectorPlanner, formatAnnProbeReport, memoryVectorSqlShape, runFilteredAnnProbe, chunkVectorSqlShape, parseProbeArgs, recommendAnnTuning, type ProbeResult } from "../scripts/probe-filtered-ann";

const TEST_TIMEOUT_MS = 30000;

test("P1.5 probe CLI defaults to a 50k-row evidence run and parses ef_search sweeps", () => {
  expect(parseProbeArgs([])).toMatchObject({ rows: 50_000, dim: 384, efSearchValues: [40, 100, 200] });
  expect(parseProbeArgs(["--rows", "120", "--dim", "4", "--ef", "8,16"])).toMatchObject({ rows: 120, dim: 4, efSearchValues: [8, 16] });
  expect(() => parseProbeArgs(["--rows", "0"])).toThrow(/rows/);
  expect(() => parseProbeArgs(["--ef", "nope"])).toThrow(/ef/);
});

test("P1.5 query shapes preserve the production filtered vector searches", () => {
  expect(memoryVectorSqlShape).toContain("FROM memory_entry");
  expect(memoryVectorSqlShape).toContain("org_id = $ORG_ID");
  expect(memoryVectorSqlShape).toContain("memory_embedding IS NOT NULL");
  expect(memoryVectorSqlShape).toContain("is_latest = true");
  expect(memoryVectorSqlShape).toContain("is_forgotten = false");
  expect(memoryVectorSqlShape).toContain("space_id IN (SELECT id FROM space WHERE container_tag = $containerTag");
  expect(memoryVectorSqlShape).toContain("ORDER BY memory_embedding <=> $queryVector::vector");

  expect(chunkVectorSqlShape).toContain("FROM chunk c JOIN document d ON d.id = c.document_id");
  expect(chunkVectorSqlShape).toContain("d.org_id = $ORG_ID");
  expect(chunkVectorSqlShape).toContain("d.container_tags @> ARRAY[$containerTag]::text[]");
  expect(chunkVectorSqlShape).toContain("ORDER BY c.embedding <=> $queryVector::vector");
});


test("P1.5 planner classifier only counts the vector HNSW index", () => {
  expect(classifyVectorPlanner("Index Scan using unique_container_tag_per_org on space\nSeq Scan on memory_entry")).toBe("seq-scan");
  expect(classifyVectorPlanner("Index Scan using idx_memory_entry_embedding_hnsw on memory_entry")).toBe("vector-index");
  expect(classifyVectorPlanner("Index Scan using idx_chunk_embedding_hnsw on chunk c")).toBe("vector-index");
});

test("P1.5 plan parser reports actual returned rows, not planner estimates", () => {
  expect(actualReturnedRows("Limit  (cost=15 rows=2 width=88) (actual time=1.0..2.0 rows=5 loops=1)")).toBe(5);
  expect(actualReturnedRows("QUERY PLAN\nSeq Scan on chunk  (cost=1 rows=200 width=1) (actual time=0..1 rows=200 loops=1)")).toBe(200);
  expect(actualReturnedRows("QUERY PLAN without actual row count")).toBe(0);
});

test("P1.5 tuning recommendation requires both production vector legs to use HNSW", () => {
  const result = (target: "memories" | "chunks", planner: ProbeResult["planner"]): ProbeResult => ({
    target,
    planner,
    efSearch: 40,
    returnedRows: 10,
    latencyMs: 1,
    planText: "",
  });

  expect(recommendAnnTuning([result("memories", "seq-scan"), result("chunks", "seq-scan")])).toContain("No HNSW plan observed");
  expect(recommendAnnTuning([result("memories", "vector-index"), result("chunks", "seq-scan")])).toContain("Partial HNSW plan coverage");
  expect(recommendAnnTuning([result("memories", "vector-index"), result("chunks", "vector-index")])).toContain("No BELLA_HNSW_EF_SEARCH knob is recommended");
});

test("P1.5 filtered-ANN probe returns plans, timings, and a recommendation", async () => {
  const report = await runFilteredAnnProbe({ rows: 160, dim: 4, efSearchValues: [8, 16], quiet: true });

  expect(report.rowCount).toBe(160);
  expect(report.dim).toBe(4);
  expect(report.results.map((r) => `${r.target}:${r.efSearch}`)).toEqual(["memories:8", "chunks:8", "memories:16", "chunks:16"]);
  for (const result of report.results) {
    expect(result.planText).toContain("QUERY PLAN");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.returnedRows).toBeGreaterThan(0);
  }
  expect(report.recommendation).toContain("hnsw.ef_search");

  const rendered = formatAnnProbeReport(report);
  expect(rendered).toContain("Bellamente P1.5 filtered-ANN probe");
  expect(rendered).toContain("| target | ef_search | returned | latency ms | planner | recommendation |");
  expect(rendered).toContain(memoryVectorSqlShape);
  expect(rendered).toContain(chunkVectorSqlShape);
}, TEST_TIMEOUT_MS);
