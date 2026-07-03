// scripts/probe-filtered-ann.ts - P1.5 evidence harness for filtered pgvector queries under PGlite.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { schemaForDim } from "../src/db";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { ORG_ID, toVector } from "../src/util";

export type ProbeTarget = "memories" | "chunks";
export type ProbeOptions = {
  rows?: number;
  dim?: number;
  efSearchValues?: number[];
  limit?: number;
  containerTag?: string;
  quiet?: boolean;
};
export type ProbeResult = {
  target: ProbeTarget;
  efSearch: number;
  returnedRows: number;
  latencyMs: number;
  planner: "vector-index" | "seq-scan" | "other";
  planText: string;
};
export type ProbeReport = {
  generatedAt: string;
  rowCount: number;
  dim: number;
  limit: number;
  containerTag: string;
  results: ProbeResult[];
  recommendation: string;
};

type ParsedArgs = Required<Pick<ProbeOptions, "rows" | "dim" | "efSearchValues" | "limit" | "containerTag">>;

const DEFAULT_ROWS = 50_000;
const DEFAULT_DIM = 384;
const DEFAULT_LIMIT = 10;
const DEFAULT_EF = [40, 100, 200];
const DEFAULT_TAG = "ann_probe";
const SPACE_ID = "annprobe-space-000001";
const DOC_ID = "annprobe-doc-00000001";
const MODEL = "ann-probe-deterministic";

export const memoryVectorSqlShape = [
  "SELECT id, memory, version, created_at, memory_embedding,",
  "       1 - (memory_embedding <=> $queryVector::vector) AS similarity",
  "FROM memory_entry",
  "WHERE org_id = $ORG_ID AND memory_embedding IS NOT NULL",
  "  AND is_latest = true",
  "  AND is_forgotten = false AND (forget_after IS NULL OR forget_after > now())",
  "  AND space_id IN (SELECT id FROM space WHERE container_tag = $containerTag AND org_id = $ORG_ID)",
  "ORDER BY memory_embedding <=> $queryVector::vector",
  "LIMIT $limit",
].join("\n");

export const chunkVectorSqlShape = [
  "SELECT c.id, c.content, c.document_id, c.metadata, d.title, d.filepath,",
  "       1 - (c.embedding <=> $queryVector::vector) AS similarity",
  "FROM chunk c JOIN document d ON d.id = c.document_id",
  "WHERE d.org_id = $ORG_ID AND c.embedding IS NOT NULL",
  "  AND d.container_tags @> ARRAY[$containerTag]::text[]",
  "ORDER BY c.embedding <=> $queryVector::vector",
  "LIMIT $limit",
].join("\n");

function positiveInt(name: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function parseProbeArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    rows: DEFAULT_ROWS,
    dim: DEFAULT_DIM,
    efSearchValues: DEFAULT_EF,
    limit: DEFAULT_LIMIT,
    containerTag: DEFAULT_TAG,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === "--rows") out.rows = positiveInt("rows", next());
    else if (arg === "--dim") out.dim = positiveInt("dim", next());
    else if (arg === "--limit") out.limit = positiveInt("limit", next());
    else if (arg === "--tag") out.containerTag = next();
    else if (arg === "--ef") {
      out.efSearchValues = next().split(",").map((v) => positiveInt("ef", v.trim()));
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("usage: bun run scripts/probe-filtered-ann.ts [--rows 50000] [--dim 384] [--ef 40,100,200] [--limit 10] [--tag ann_probe]");
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!out.containerTag.trim()) throw new Error("tag must be non-empty");
  if (out.dim > 2000) throw new Error("dim must fit pgvector HNSW index limit (<= 2000)");
  return out;
}

function vectorFor(i: number, dim: number): string {
  const values = new Array<number>(dim).fill(0);
  values[0] = 1;
  if (dim > 1) values[1] = (i % 97) / 1000;
  if (dim > 2) values[2] = ((i * 17) % 89) / 1000;
  if (dim > 3) values[3] = ((i * 31) % 83) / 1000;
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  return toVector(values.map((x) => x / norm));
}

async function seedProbe(sql: Sql, opts: ParsedArgs): Promise<void> {
  await sql`INSERT INTO space (id, container_tag, org_id) VALUES (${SPACE_ID}, ${opts.containerTag}, ${ORG_ID}) ON CONFLICT (container_tag, org_id) DO NOTHING`;
  await sql`
    INSERT INTO document (id, content, type, source, status, task_type, container_tags, title, org_id)
    VALUES (${DOC_ID}, ${"ANN probe corpus"}, 'text', 'probe', 'done', 'superrag', ${[opts.containerTag]}, ${"ANN probe"}, ${ORG_ID})`;

  const batchSize = 1000;
  for (let start = 0; start < opts.rows; start += batchSize) {
    const end = Math.min(opts.rows, start + batchSize);
    const memoryRows: {
      id: string;
      org_id: string;
      space_id: string;
      memory: string;
      is_latest: boolean;
      is_forgotten: boolean;
      version: number;
      root_memory_id: string;
      embedding: string;
      model: string;
    }[] = [];
    const chunkRows: {
      id: string;
      document_id: string;
      content: string;
      position: number;
      embedding: string;
      model: string;
    }[] = [];
    for (let i = start; i < end; i++) {
      const v = vectorFor(i, opts.dim);
      const memId = `am${String(i).padStart(20, "0")}`;
      const chunkId = `ac${String(i).padStart(20, "0")}`;
      memoryRows.push({
        id: memId,
        org_id: ORG_ID,
        space_id: SPACE_ID,
        memory: `probe memory ${i}`,
        is_latest: true,
        is_forgotten: false,
        version: 1,
        root_memory_id: memId,
        embedding: v,
        model: MODEL,
      });
      chunkRows.push({
        id: chunkId,
        document_id: DOC_ID,
        content: `probe chunk ${i}`,
        position: i,
        embedding: v,
        model: MODEL,
      });
    }
    await sql`
      INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, is_forgotten, version, root_memory_id, memory_embedding, memory_embedding_model)
      SELECT id, org_id, space_id, memory, is_latest, is_forgotten, version, root_memory_id, embedding::vector, model
      FROM json_to_recordset(${sql.json(memoryRows)}) AS x(
        id text,
        org_id text,
        space_id text,
        memory text,
        is_latest boolean,
        is_forgotten boolean,
        version int,
        root_memory_id text,
        embedding text,
        model text
      )`;
    await sql`
      INSERT INTO chunk (id, document_id, content, position, embedding, embedding_model)
      SELECT id, document_id, content, position, embedding::vector, model
      FROM json_to_recordset(${sql.json(chunkRows)}) AS x(
        id text,
        document_id text,
        content text,
        position int,
        embedding text,
        model text
      )`;
  }
  await sql`UPDATE document SET chunk_count = ${opts.rows} WHERE id = ${DOC_ID}`;
  await sql`ANALYZE memory_entry`;
  await sql`ANALYZE document`;
  await sql`ANALYZE chunk`;
}

export function classifyVectorPlanner(planText: string): "vector-index" | "seq-scan" | "other" {
  if (/idx_(memory_entry|chunk)_embedding_hnsw/i.test(planText)) return "vector-index";
  if (/Seq Scan on (memory_entry|chunk)\b/i.test(planText)) return "seq-scan";
  return "other";
}

export function actualReturnedRows(planText: string): number {
  const m = /actual time=[^)]* rows=(\d+) loops=\d+\)/.exec(planText);
  return m ? Number(m[1]) : 0;
}

function extractReturnedRows(planRows: { "QUERY PLAN": string }[]): number {
  return actualReturnedRows(planRows.map((r) => r["QUERY PLAN"]).join("\n"));
}

async function explainMemory(sql: Sql, queryVector: string, opts: ParsedArgs): Promise<{ rows: { "QUERY PLAN": string }[]; returnedRows: number }> {
  const rows = await sql<{ "QUERY PLAN": string }[]>`
    EXPLAIN ANALYZE
    SELECT id, memory, version, created_at, memory_embedding,
           1 - (memory_embedding <=> ${queryVector}::vector) AS similarity
    FROM memory_entry
    WHERE org_id = ${ORG_ID} AND memory_embedding IS NOT NULL
      AND is_latest = true
      AND is_forgotten = false AND (forget_after IS NULL OR forget_after > now())
      AND space_id IN (SELECT id FROM space WHERE container_tag = ${opts.containerTag} AND org_id = ${ORG_ID})
    ORDER BY memory_embedding <=> ${queryVector}::vector
    LIMIT ${opts.limit}`;
  return { rows, returnedRows: extractReturnedRows(rows) };
}

async function explainChunk(sql: Sql, queryVector: string, opts: ParsedArgs): Promise<{ rows: { "QUERY PLAN": string }[]; returnedRows: number }> {
  const rows = await sql<{ "QUERY PLAN": string }[]>`
    EXPLAIN ANALYZE
    SELECT c.id, c.content, c.document_id, c.metadata, d.title, d.filepath,
           1 - (c.embedding <=> ${queryVector}::vector) AS similarity
    FROM chunk c JOIN document d ON d.id = c.document_id
    WHERE d.org_id = ${ORG_ID} AND c.embedding IS NOT NULL
      AND d.container_tags @> ARRAY[${opts.containerTag}]::text[]
    ORDER BY c.embedding <=> ${queryVector}::vector
    LIMIT ${opts.limit}`;
  return { rows, returnedRows: extractReturnedRows(rows) };
}

async function runOne(sql: Sql, target: ProbeTarget, efSearch: number, queryVector: string, opts: ParsedArgs): Promise<ProbeResult> {
  await sql.unsafe(`SET hnsw.ef_search = ${efSearch}`);
  const t0 = performance.now();
  const explained = target === "memories" ? await explainMemory(sql, queryVector, opts) : await explainChunk(sql, queryVector, opts);
  const latencyMs = performance.now() - t0;
  const planText = ["QUERY PLAN", ...explained.rows.map((r) => r["QUERY PLAN"])].join("\n");
  return { target, efSearch, returnedRows: explained.returnedRows, latencyMs, planner: classifyVectorPlanner(planText), planText };
}

export function recommendAnnTuning(results: ProbeResult[]): string {
  const hasResults = results.length > 0;
  const allUseIndex = hasResults && results.every((r) => r.planner === "vector-index");
  const someUseIndex = results.some((r) => r.planner === "vector-index");
  const fastest = [...results].sort((a, b) => a.latencyMs - b.latencyMs)[0];
  if (!someUseIndex) {
    return "No HNSW plan observed at this scale/filter shape; do not add BELLA_HNSW_EF_SEARCH or set hnsw.ef_search yet. Keep over-fetching and use P1.5 data as the tuning baseline.";
  }
  if (!allUseIndex) {
    return "Partial HNSW plan coverage observed: at least one production-shaped vector leg did not use its HNSW index. Do not add BELLA_HNSW_EF_SEARCH yet; investigate the non-indexed leg and keep over-fetching until both memory and chunk probes show vector-index plans.";
  }
  return `No BELLA_HNSW_EF_SEARCH knob is recommended from this probe: PGlite engages HNSW for the filtered production-shaped vector queries at scale, and this plan/latency probe does not measure recall quality. Keep default hnsw.ef_search; revisit only with recall-vs-brute-force evidence. Fastest observed leg: ${fastest?.target} ef=${fastest?.efSearch}.`;
}

export async function runFilteredAnnProbe(raw: ProbeOptions = {}): Promise<ProbeReport> {
  const opts: ParsedArgs = {
    rows: raw.rows ?? DEFAULT_ROWS,
    dim: raw.dim ?? DEFAULT_DIM,
    efSearchValues: raw.efSearchValues ?? DEFAULT_EF,
    limit: raw.limit ?? DEFAULT_LIMIT,
    containerTag: raw.containerTag ?? DEFAULT_TAG,
  };
  parseProbeArgs(["--rows", String(opts.rows), "--dim", String(opts.dim), "--ef", opts.efSearchValues.join(","), "--limit", String(opts.limit), "--tag", opts.containerTag]);
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  try {
    await sql.unsafe(schemaForDim(opts.dim));
    await seedProbe(sql, opts);
    const queryVector = vectorFor(0, opts.dim);
    const results: ProbeResult[] = [];
    for (const ef of opts.efSearchValues) {
      results.push(await runOne(sql, "memories", ef, queryVector, opts));
      results.push(await runOne(sql, "chunks", ef, queryVector, opts));
    }
    const report: ProbeReport = {
      generatedAt: new Date().toISOString(),
      rowCount: opts.rows,
      dim: opts.dim,
      limit: opts.limit,
      containerTag: opts.containerTag,
      results,
      recommendation: recommendAnnTuning(results),
    };
    if (!raw.quiet) console.log(formatAnnProbeReport(report));
    return report;
  } finally {
    await sql.end();
  }
}

function fmtMs(n: number): string {
  return n.toFixed(1);
}

export function formatAnnProbeReport(report: ProbeReport): string {
  const lines = [
    "Bellamente P1.5 filtered-ANN probe",
    `generatedAt=${report.generatedAt} rows=${report.rowCount} dim=${report.dim} limit=${report.limit} containerTag=${report.containerTag}`,
    "",
    "Memory vector SQL shape:",
    "```sql",
    memoryVectorSqlShape,
    "```",
    "",
    "Chunk vector SQL shape:",
    "```sql",
    chunkVectorSqlShape,
    "```",
    "",
    "| target | ef_search | returned | latency ms | planner | recommendation |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const result of report.results) {
    lines.push(`| ${result.target} | ${result.efSearch} | ${result.returnedRows} | ${fmtMs(result.latencyMs)} | ${result.planner} | ${report.recommendation} |`);
  }
  lines.push("", "## Plan Output");
  for (const result of report.results) {
    lines.push("", `### ${result.target} ef_search=${result.efSearch}`, "```", result.planText, "```");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const opts = parseProbeArgs(Bun.argv.slice(2));
  await runFilteredAnnProbe(opts);
}
