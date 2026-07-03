// scripts/eval-e2e.ts - P1.1 retrieval benchmark through the real HTTP app routes.
// This is a system harness: fixtures load through /memories and /documents, queries go through /search,
// and the brute-force comparison is computed from the same DB contents.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { buildApp } from "../src/index";
import { schemaForDim } from "../src/db";
import { EMBED_DIM, embedModelName } from "../src/embed-common";
import type { Embed } from "../src/embed";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { ORG_ID } from "../src/util";
import type { SearchResult } from "../src/search";

export type SearchMode = "memories" | "documents" | "hybrid";

export type EvalGold = { type: "memory" | "chunk"; stableId: string };
export type EvalQuery = { id: string; q: string; searchMode: SearchMode; gold: EvalGold[] };
export type EvalMemory = { stableId: string; content: string };
export type EvalDocument = { stableId: string; title: string; filepath: string; content: string };

export type EvalDataset = {
  seed: number;
  containerTag: string;
  memories: EvalMemory[];
  documents: EvalDocument[];
  queries: EvalQuery[];
};

export type ModeMetrics = {
  searchMode: SearchMode;
  queryCount: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  indexedVectorRecallAt10: number;
  bruteForceRecallAt10: number;
  annLossAt10: number;
};

export type EvalReport = {
  generatedAt: string;
  dataset: {
    seed: number;
    containerTag: string;
    memoryCount: number;
    documentCount: number;
    queryCount: number;
    embedder: string;
  };
  routeCounts: Record<string, number>;
  modes: Record<SearchMode, ModeMetrics>;
};

type RunOptions = {
  dataset?: EvalDataset;
  quiet?: boolean;
  limit?: number;
  threshold?: number;
  embed?: Embed;
  embedder?: string;
};

type LoadedIds = {
  goldToActual: Map<string, string>;
};

type Candidate = { key: string; score: number };

const MODES: SearchMode[] = ["memories", "documents", "hybrid"];
const DEFAULT_SEED = 20260702;
const DEFAULT_LIMIT = 10;
const RRF_K = 60;

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function stableToken(prefix: string, i: number): string {
  return `${prefix}${String(i).padStart(3, "0")}`;
}

export function createEvalDataset(opts: { seed?: number } = {}): EvalDataset {
  const seed = opts.seed ?? DEFAULT_SEED;
  const rng = makeRng(seed);
  const containerTag = `eval-${seed}`;
  const memories: EvalMemory[] = [];
  const documents: EvalDocument[] = [];
  const queries: EvalQuery[] = [];

  const people = ["Ada", "Ben", "Cyra", "Dale", "Eli", "Fran", "Gio", "Hana", "Ira", "Jules"];
  const editors = ["Helix", "Neovim", "Zed", "VS Code", "Nova", "Emacs"];
  const units = ["metric units", "imperial units", "celsius", "fahrenheit", "24 hour time", "12 hour time"];
  const regions = ["Denver", "Boston", "Seattle", "Austin", "Chicago", "Portland", "Phoenix"];
  const services = ["atlas", "beacon", "comet", "delta", "ember", "forge", "granite", "harbor"];
  const commands = ["restart", "rollback", "reindex", "snapshot", "rotate", "restore", "promote"];

  for (let i = 0; i < 44; i++) {
    const token = stableToken("memtoken", i);
    const person = pick(rng, people);
    const editor = pick(rng, editors);
    const unit = pick(rng, units);
    const region = pick(rng, regions);
    const stableId = `memory-${token}`;
    memories.push({
      stableId,
      content:
        `Eval memory ${token}. ${person} prefers ${unit}, uses ${editor} for agent work, ` +
        `and keeps project notes for ${region}. The backup code is code${i}.`,
    });
    queries.push({
      id: `q-memory-${token}`,
      searchMode: "memories",
      q: `For ${token}, which editor does ${person} use for agent work?`,
      gold: [{ type: "memory", stableId }],
    });

    if (i % 2 === 0) {
      const distractorToken = stableToken("memdistractor", i);
      memories.push({
        stableId: `memory-${distractorToken}`,
        content:
          `Eval memory ${distractorToken}. ${person} tried ${pick(rng, editors)} for agent work, ` +
          `kept old ${unit} notes, and mentioned ${region} as a decoy project.`,
      });
    }
  }

  for (let i = 0; i < 36; i++) {
    const token = stableToken("doctoken", i);
    const service = pick(rng, services);
    const command = pick(rng, commands);
    const region = pick(rng, regions);
    const stableId = `document-${token}`;
    documents.push({
      stableId,
      title: `Runbook ${token}`,
      filepath: `eval/${token}.md`,
      content:
        `# Runbook ${token}\n\n` +
        `Service ${service} runs in ${region}. The recovery command for ${token} is ${command}. ` +
        `Near-duplicate services use a different token and must not satisfy this query.`,
    });
    queries.push({
      id: `q-document-${token}`,
      searchMode: "documents",
      q: `What is the recovery command for ${token}?`,
      gold: [{ type: "chunk", stableId }],
    });
  }

  for (let i = 0; i < 30; i++) {
    const token = stableToken("hybtoken", i);
    const service = pick(rng, services);
    const owner = pick(rng, people);
    const command = pick(rng, commands);
    const memoryStableId = `hybrid-memory-${token}`;
    const docStableId = `hybrid-document-${token}`;
    memories.push({
      stableId: memoryStableId,
      content: `Hybrid memory ${token}. ${owner} owns service ${service} and reviews its escalation notes weekly.`,
    });
    documents.push({
      stableId: docStableId,
      title: `Hybrid playbook ${token}`,
      filepath: `eval/${token}.md`,
      content:
        `# Hybrid playbook ${token}\n\n` +
        `Service ${service} uses the ${command} playbook when ${token} appears in an incident.`,
    });
    queries.push({
      id: `q-hybrid-${token}`,
      searchMode: "hybrid",
      q: `For ${token}, who owns ${service} or which playbook command is used?`,
      gold: [
        { type: "memory", stableId: memoryStableId },
        { type: "chunk", stableId: docStableId },
      ],
    });
  }

  return { seed, containerTag, memories, documents, queries };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tokenWeight(token: string): number {
  if (/^(memtoken|memdistractor|doctoken|hybtoken|code)\d+/.test(token)) return 6;
  if (/^(service|runbook|playbook|memory|hybrid|recovery|command|editor|owns)$/.test(token)) return 2;
  return 1;
}

function embedOne(text: string): number[] {
  const out = new Array<number>(EMBED_DIM).fill(0);
  for (const token of tokenize(text)) {
    const index = hashToken(token) % EMBED_DIM;
    out[index] += tokenWeight(token);
  }
  let norm = Math.sqrt(out.reduce((sum, x) => sum + x * x, 0));
  if (!norm) {
    out[0] = 1;
    norm = 1;
  }
  return out.map((x) => x / norm);
}

export const evalEmbed: Embed = async ({ values }) => values.map(embedOne);

function resultKey(result: SearchResult): string {
  return `${result.type}:${result.id}`;
}

function goldKey(gold: EvalGold): string {
  return `${gold.type}:${gold.stableId}`;
}

function actualGoldKeys(query: EvalQuery, loaded: LoadedIds): Set<string> {
  const keys = new Set<string>();
  for (const gold of query.gold) {
    const actual = loaded.goldToActual.get(goldKey(gold));
    if (actual) keys.add(`${gold.type}:${actual}`);
  }
  return keys;
}

function inc(routeCounts: Record<string, number>, route: string) {
  routeCounts[route] = (routeCounts[route] ?? 0) + 1;
}

async function requestJson<T>(
  app: ReturnType<typeof buildApp>,
  routeCounts: Record<string, number>,
  route: string,
  path: string,
  init?: RequestInit,
): Promise<{ json: T; response: Response }> {
  inc(routeCounts, route);
  const response = await app.request(path, init);
  if (!response.ok) {
    throw new Error(`${route} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return { json: (await response.json()) as T, response };
}

async function loadFixtures(app: ReturnType<typeof buildApp>, routeCounts: Record<string, number>, dataset: EvalDataset): Promise<LoadedIds> {
  const goldToActual = new Map<string, string>();
  const memoryResponse = await requestJson<{ memories: { id: string }[] }>(app, routeCounts, "POST /memories", "/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      containerTag: dataset.containerTag,
      dedupe: false,
      memories: dataset.memories.map((m) => ({ content: m.content })),
    }),
  });
  dataset.memories.forEach((m, i) => {
    const id = memoryResponse.json.memories[i]?.id;
    if (!id) throw new Error(`missing created memory id for ${m.stableId}`);
    goldToActual.set(`memory:${m.stableId}`, id);
  });

  for (const doc of dataset.documents) {
    const created = await requestJson<{ documentId: string }>(app, routeCounts, "POST /documents", "/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: doc.title,
        content: doc.content,
        filepath: doc.filepath,
        containerTag: dataset.containerTag,
      }),
    });
    const detail = await requestJson<{ chunks: { id: string; content: string }[] }>(
      app,
      routeCounts,
      "GET /documents/:id",
      `/documents/${created.json.documentId}`,
    );
    const firstChunk = detail.json.chunks[0];
    if (!firstChunk) throw new Error(`document ${doc.stableId} produced no chunks`);
    goldToActual.set(`chunk:${doc.stableId}`, firstChunk.id);
  }

  return { goldToActual };
}

function percentile(values: number[], pct: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function scoreRanking(keys: string[], gold: Set<string>): { r1: number; r5: number; r10: number; reciprocalRank: number } {
  const rank = keys.findIndex((key) => gold.has(key));
  return {
    r1: rank >= 0 && rank < 1 ? 1 : 0,
    r5: rank >= 0 && rank < 5 ? 1 : 0,
    r10: rank >= 0 && rank < 10 ? 1 : 0,
    reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!;
  return dot;
}

async function bruteForceList(embed: Embed, sql: Sql, mode: "memories" | "documents", q: string, containerTag: string, limit: number): Promise<Candidate[]> {
  const [queryVec] = await embed({ values: [q], taskType: "QUESTION_ANSWERING" });
  if (!queryVec) return [];

  if (mode === "memories") {
    const rows = await sql<{ id: string; text: string }[]>`
      SELECT id, memory AS text
      FROM memory_entry
      WHERE org_id = ${ORG_ID} AND is_latest = true AND is_forgotten = false
        AND (forget_after IS NULL OR forget_after > now())
        AND space_id IN (SELECT id FROM space WHERE container_tag = ${containerTag} AND org_id = ${ORG_ID})`;
    const vectors = await embed({ values: rows.map((r) => r.text), taskType: "RETRIEVAL_DOCUMENT" });
    return rows
      .map((r, i) => ({ key: `memory:${r.id}`, score: cosine(queryVec, vectors[i]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const rows = await sql<{ id: string; text: string }[]>`
    SELECT c.id, COALESCE(c.embedded_content, c.content) AS text
    FROM chunk c JOIN document d ON d.id = c.document_id
    WHERE d.org_id = ${ORG_ID} AND d.container_tags @> ARRAY[${containerTag}]::text[]`;
  const vectors = await embed({ values: rows.map((r) => r.text), taskType: "RETRIEVAL_DOCUMENT" });
  return rows
    .map((r, i) => ({ key: `chunk:${r.id}`, score: cosine(queryVec, vectors[i]!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function bruteForceSearch(embed: Embed, sql: Sql, query: EvalQuery, containerTag: string, limit: number): Promise<string[]> {
  if (query.searchMode === "memories") return (await bruteForceList(embed, sql, "memories", query.q, containerTag, limit)).map((r) => r.key);
  if (query.searchMode === "documents") return (await bruteForceList(embed, sql, "documents", query.q, containerTag, limit)).map((r) => r.key);

  const lists = await Promise.all([
    bruteForceList(embed, sql, "memories", query.q, containerTag, limit),
    bruteForceList(embed, sql, "documents", query.q, containerTag, limit),
  ]);
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((candidate, i) => {
      score.set(candidate.key, (score.get(candidate.key) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key]) => key);
}

async function makeEvalApp(embed: Embed) {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  const app = buildApp({ sql, embed }, { required: false, key: null, source: "none" });
  return { app, sql, close: () => sql.end() };
}

async function evaluateMode(
  app: ReturnType<typeof buildApp>,
  sql: Sql,
  routeCounts: Record<string, number>,
  dataset: EvalDataset,
  loaded: LoadedIds,
  mode: SearchMode,
  opts: { limit: number; threshold?: number; embed: Embed },
): Promise<ModeMetrics> {
  const queries = dataset.queries.filter((q) => q.searchMode === mode);
  const latencies: number[] = [];
  let r1 = 0, r5 = 0, r10 = 0, mrr = 0, indexedR10 = 0, bruteR10 = 0;

  for (const query of queries) {
    const gold = actualGoldKeys(query, loaded);
    const body: Record<string, unknown> = {
      q: query.q,
      searchMode: query.searchMode,
      containerTag: dataset.containerTag,
      limit: opts.limit,
    };
    if (opts.threshold !== undefined) body.threshold = opts.threshold;

    const t0 = performance.now();
    const searched = await requestJson<{ results: SearchResult[] }>(app, routeCounts, "POST /search", "/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    latencies.push(performance.now() - t0);
    const ranked = searched.json.results.map(resultKey);
    const scored = scoreRanking(ranked, gold);
    r1 += scored.r1;
    r5 += scored.r5;
    r10 += scored.r10;
    mrr += scored.reciprocalRank;

    const indexedVector = await requestJson<{ results: SearchResult[] }>(app, routeCounts, "POST /search", "/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        q: query.q,
        searchMode: query.searchMode,
        containerTag: dataset.containerTag,
        limit: opts.limit,
        threshold: 0,
        keyword: false,
        recency: false,
        diversify: false,
      }),
    });
    indexedR10 += scoreRanking(indexedVector.json.results.map(resultKey), gold).r10;
    bruteR10 += scoreRanking(await bruteForceSearch(opts.embed, sql, query, dataset.containerTag, opts.limit), gold).r10;
  }

  const n = Math.max(queries.length, 1);
  const indexedVectorRecallAt10 = indexedR10 / n;
  const bruteForceRecallAt10 = bruteR10 / n;
  return {
    searchMode: mode,
    queryCount: queries.length,
    recallAt1: r1 / n,
    recallAt5: r5 / n,
    recallAt10: r10 / n,
    mrr: mrr / n,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    indexedVectorRecallAt10,
    bruteForceRecallAt10,
    annLossAt10: Math.max(0, bruteForceRecallAt10 - indexedVectorRecallAt10),
  };
}

export async function runEvalE2E(opts: RunOptions = {}): Promise<EvalReport> {
  const dataset = opts.dataset ?? createEvalDataset();
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const routeCounts: Record<string, number> = {};
  const embed = opts.embed ?? evalEmbed;
  const embedder = opts.embedder ?? "deterministic-hash";
  const { app, sql, close } = await makeEvalApp(embed);
  try {
    const loaded = await loadFixtures(app, routeCounts, dataset);
    const rows = {} as Record<SearchMode, ModeMetrics>;
    for (const mode of MODES) {
      rows[mode] = await evaluateMode(app, sql, routeCounts, dataset, loaded, mode, { limit, threshold: opts.threshold, embed });
    }
    const report: EvalReport = {
      generatedAt: new Date().toISOString(),
      dataset: {
        seed: dataset.seed,
        containerTag: dataset.containerTag,
        memoryCount: dataset.memories.length,
        documentCount: dataset.documents.length,
        queryCount: dataset.queries.length,
        embedder,
      },
      routeCounts,
      modes: rows,
    };
    if (!opts.quiet) console.log(formatMetricsTable(report));
    return report;
  } finally {
    await close();
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ms(n: number): string {
  return n.toFixed(1);
}

export function formatMetricsTable(report: EvalReport): string {
  const lines = [
    "Bellamente P1.1 E2E retrieval benchmark",
    `seed=${report.dataset.seed} embedder=${report.dataset.embedder} memories=${report.dataset.memoryCount} documents=${report.dataset.documentCount} queries=${report.dataset.queryCount}`,
    "",
    "| mode | queries | recall@1 | recall@5 | recall@10 | MRR | p50 ms | p95 ms | indexed vec recall@10 | brute-force recall@10 | ANN loss@10 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const mode of MODES) {
    const row = report.modes[mode];
    lines.push(
      `| ${mode} | ${row.queryCount} | ${pct(row.recallAt1)} | ${pct(row.recallAt5)} | ${pct(row.recallAt10)} | ` +
        `${row.mrr.toFixed(3)} | ${ms(row.latencyP50Ms)} | ${ms(row.latencyP95Ms)} | ` +
        `${pct(row.indexedVectorRecallAt10)} | ${pct(row.bruteForceRecallAt10)} | ${pct(row.annLossAt10)} |`,
    );
  }
  lines.push(
    "",
    `Route calls: ${Object.entries(report.routeCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );
  return lines.join("\n");
}

type CliDeps = {
  env?: Pick<NodeJS.ProcessEnv, "BELLA_EVAL_REAL_EMBED">;
  run?: (opts?: RunOptions) => Promise<void | EvalReport>;
  loadEmbedModule?: () => Promise<{ makeEmbed: () => Embed; prewarmEmbed: (embed: Embed) => Promise<void> }>;
};

export async function runEvalCli(deps: CliDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runEvalE2E;
  if (env.BELLA_EVAL_REAL_EMBED === "1") {
    const { makeEmbed: makeEmbedForCli, prewarmEmbed: prewarmEmbedForCli } = await (deps.loadEmbedModule ?? (() => import("../src/embed")))();
    const embed = makeEmbedForCli();
    await prewarmEmbedForCli(embed);
    await run({ embed, embedder: `active:${embedModelName()}` });
    return;
  }
  await run();
}

if (import.meta.main) await runEvalCli();