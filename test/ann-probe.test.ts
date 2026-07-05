// ann-probe.test.ts - P1.5 filtered-ANN probe contract.
// The probe must exercise production-shaped vector queries and emit evidence, not guesses.
// PR #93 review findings F1/F2/F3/F6/F7/F8 hardened this contract: the probe defaults to the
// PRODUCTION over-fetch LIMIT, detects ef_search truncation, supports selective filters, and
// couples its query shapes to src/search.ts so drift cannot go unnoticed.
import { test, expect } from "bun:test";
import { actualReturnedRows, classifyVectorPlanner, formatAnnProbeReport, memoryVectorSqlShape, runFilteredAnnProbe, chunkVectorSqlShape, parseProbeArgs, recommendAnnTuning, type ProbeResult } from "../scripts/probe-filtered-ann";
import { Q } from "../src/search";

const TEST_TIMEOUT_MS = 30000;

test("P1.5 probe CLI defaults to a 50k-row evidence run at the PRODUCTION over-fetch LIMIT", () => {
  // F1: production vector legs run LIMIT = limit * RESULTS_PER_QUERY (src/search.ts). The default
  // request limit is 10, so the probe's default LIMIT must be 150 — evidence at LIMIT 10 measured
  // a query production never issues.
  expect(parseProbeArgs([])).toMatchObject({ rows: 50_000, dim: 384, efSearchValues: [40, 100, 200], limit: 150, spaces: 1, iterative: "off" });
  expect(parseProbeArgs([]).limit).toBe(10 * Q.RESULTS_PER_QUERY);
  expect(parseProbeArgs(["--rows", "120", "--dim", "4", "--ef", "8,16"])).toMatchObject({ rows: 120, dim: 4, efSearchValues: [8, 16] });
  expect(() => parseProbeArgs(["--rows", "0"])).toThrow(/rows/);
  expect(() => parseProbeArgs(["--ef", "nope"])).toThrow(/ef/);
});

test("P1.5 probe CLI parses selectivity and iterative-scan options", () => {
  // F3: --spaces N seeds rows across N spaces/tags so the probed tag matches only 1/N of the
  // corpus — the filtered-ANN footgun requires selective filters to manifest.
  expect(parseProbeArgs(["--spaces", "20"])).toMatchObject({ spaces: 20 });
  expect(() => parseProbeArgs(["--spaces", "0"])).toThrow(/spaces/);
  // F5: pgvector 0.8+ iterative scan is the upstream remedy for post-filter shortfall.
  expect(parseProbeArgs(["--iterative", "relaxed_order"])).toMatchObject({ iterative: "relaxed_order" });
  expect(parseProbeArgs(["--iterative", "strict_order"])).toMatchObject({ iterative: "strict_order" });
  expect(() => parseProbeArgs(["--iterative", "sideways"])).toThrow(/iterative/);
});

test("P1.5 --help prints usage and exits 0 instead of a stack trace", () => {
  // F8: a probe someone runs by hand must not crash on --help.
  const proc = Bun.spawnSync(["bun", "scripts/probe-filtered-ann.ts", "--help"], { cwd: `${import.meta.dir}/..` });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain("usage:");
}, TEST_TIMEOUT_MS);

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

test("P1.5 query shapes stay coupled to src/search.ts (drift guard)", async () => {
  // F6: the probe's SQL is a hand-copied twin of the production legs. If a distinctive clause
  // disappears from src/search.ts, this test forces someone to re-sync the probe.
  const searchSrc = await Bun.file(new URL("../src/search.ts", import.meta.url)).text();
  const productionClauses = [
    "1 - (memory_embedding <=> ",
    "AND is_latest = true",
    "AND is_forgotten = false AND (forget_after IS NULL OR forget_after > now())",
    "space_id IN (SELECT id FROM space WHERE container_tag = ",
    "FROM chunk c JOIN document d ON d.id = c.document_id",
    "1 - (c.embedding <=> ",
    "d.container_tags @> ARRAY[",
  ];
  for (const clause of productionClauses) {
    expect(searchSrc).toContain(clause);
  }
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

test("P1.5 tuning recommendation detects ef_search truncation of the over-fetch (F2)", () => {
  const result = (target: "memories" | "chunks", planner: ProbeResult["planner"], returnedRows = 10, efSearch = 40): ProbeResult => ({
    target,
    planner,
    efSearch,
    returnedRows,
    latencyMs: 1,
    planText: "",
  });

  expect(recommendAnnTuning([result("memories", "seq-scan"), result("chunks", "seq-scan")], 10)).toContain("No HNSW plan observed");
  expect(recommendAnnTuning([result("memories", "vector-index"), result("chunks", "seq-scan")], 10)).toContain("Partial HNSW plan coverage");
  expect(recommendAnnTuning([result("memories", "vector-index"), result("chunks", "vector-index")], 10)).toContain("No BELLA_HNSW_EF_SEARCH knob is recommended");

  // The footgun issue #39 was commissioned to catch: HNSW legs returning fewer rows than the
  // requested LIMIT. All legs on the index, but returned = ef_search (40) < LIMIT (150).
  const starved = recommendAnnTuning(
    [result("memories", "vector-index", 40, 40), result("chunks", "vector-index", 40, 40)],
    150,
  );
  expect(starved).toContain("fewer rows than the requested LIMIT");
  expect(starved).toContain("issue #105");
  expect(starved).not.toContain("No BELLA_HNSW_EF_SEARCH knob is recommended");
});

test("P1.5 selective seeding makes the probed tag match only 1/N of the corpus (F3)", async () => {
  // 40 rows across 4 spaces -> exactly 10 rows carry the probed tag. Whatever plan the planner
  // picks, no leg can return more than the 10 matching rows even though LIMIT is far larger.
  const report = await runFilteredAnnProbe({ rows: 40, dim: 4, efSearchValues: [8], limit: 150, spaces: 4, quiet: true });
  expect(report.spaces).toBe(4);
  for (const result of report.results) {
    expect(result.returnedRows).toBeGreaterThan(0);
    expect(result.returnedRows).toBeLessThanOrEqual(10);
  }
}, TEST_TIMEOUT_MS);

test("P1.5 filtered-ANN probe returns plans, timings, and pins returned rows (F7)", async () => {
  const report = await runFilteredAnnProbe({ rows: 160, dim: 4, efSearchValues: [8, 16], limit: 12, quiet: true });

  expect(report.rowCount).toBe(160);
  expect(report.dim).toBe(4);
  expect(report.results.map((r) => `${r.target}:${r.efSearch}`)).toEqual(["memories:8", "chunks:8", "memories:16", "chunks:16"]);
  for (const result of report.results) {
    expect(result.planText).toContain("QUERY PLAN");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // Every row matches the tag (spaces=1), so the returned count is fully determined:
    // an HNSW scan is capped at min(ef_search, LIMIT); an exact scan fills the LIMIT.
    const expected = result.planner === "vector-index" ? Math.min(result.efSearch, 12) : 12;
    expect(result.returnedRows).toBe(expected);
  }
  expect(report.recommendation).toContain("hnsw.ef_search");

  const rendered = formatAnnProbeReport(report);
  expect(rendered).toContain("Bellamente P1.5 filtered-ANN probe");
  expect(rendered).toContain("| target | ef_search | returned | latency ms | planner | recommendation |");
  expect(rendered).toContain(memoryVectorSqlShape);
  expect(rendered).toContain(chunkVectorSqlShape);
}, TEST_TIMEOUT_MS);
