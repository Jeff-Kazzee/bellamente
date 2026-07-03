// search.ts - recall over memories and document chunks, both hybrid: vector + full-text, RRF-fused.
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { newId, toVector, ORG_ID } from "./util";
import { DEFAULT_SIMILARITY_THRESHOLD } from "./embed-common";
import { recordTraceSafe, traceItemsFromSearchResults } from "./inspect";
import { brandEnv } from "./env";

type Ctx = { sql: DB; embed: Embed };

export const Q = {
  RESULTS_PER_QUERY: 15,
  MAX_COMBINED_RESULTS: 25,
  SIMILARITY_THRESHOLD: Number(process.env.SEARCH_THRESHOLD ?? DEFAULT_SIMILARITY_THRESHOLD),
  SEARCH_TIMEOUT_MS: 10000,
  RRF_K: 60, // reciprocal-rank-fusion constant
};

export type SearchOpts = {
  q: string;
  limit?: number;
  threshold?: number;
  containerTag?: string;
  searchMode?: "memories" | "documents" | "hybrid";
  keyword?: boolean; // fuse the full-text leg (default true; false = pure vector + cosine threshold)
  recency?: boolean; // time-decay ranking on memories (default true; false = pure relevance order)
  include?: { forgottenMemories?: boolean };
};

// `score` is the FUSED ranking score (RRF × recency decay) — the order authority. `similarity` stays
// the raw cosine evidence (0 for keyword-only hits); consumers that merge result sets must sort by
// score, not similarity, or keyword hits sink (Codex review of PR #79).
export type MemoryResult = { type: "memory"; id: string; memory: string; version: number; similarity: number; score: number };

// Recency knobs (P1.2, issue #36) — read PER CALL via brandEnv() so tests and long-running processes
// tune without a restart. Semantics pinned by tests: invalid input FALLS BACK to the default;
// numeric-but-out-of-range CLAMPS. weight 0 disables recency entirely.
export function recencyWeight(): number {
  const n = Number(brandEnv("RECENCY_WEIGHT"));
  if (!Number.isFinite(n) || n < 0) return 0.15;
  return Math.min(n, 1);
}
export function recencyTauDays(): number {
  const n = Number(brandEnv("RECENCY_TAU_DAYS"));
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.min(n, 3650);
}
export type ChunkResult = {
  type: "chunk"; id: string; content: string; similarity: number; source: "vector" | "keyword" | "both";
  documentId: string; title: string | null; filepath: string | null; headingPath: string | null;
};
export type SearchResult = MemoryResult | ChunkResult;

const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 10, 1), 100);

// The ONE place rank fusion + ordering lives (thermonuclear review of PR #86, demand D1 — this
// codebase briefly had FOUR hand-rolled RRF copies, three missing the PR #79 tie-break fix).
// Legs are best-first id lists. Ties are real at small limits (the top row of each leg scores
// 1/(K+1)); ids from higher-tiePriority legs win them (literal text evidence beats semantic
// similarity; memories beat chunks), then id — ordering never depends on Map insertion order.
type FuseLeg = { ids: string[]; tiePriority: number };
function rrfFuse(legs: FuseLeg[], decay?: (id: string) => number): { id: string; score: number }[] {
  const base = new Map<string, number>();
  const priority = new Map<string, number>();
  for (const leg of legs) {
    leg.ids.forEach((id, i) => {
      base.set(id, (base.get(id) ?? 0) + 1 / (Q.RRF_K + i + 1));
      priority.set(id, Math.max(priority.get(id) ?? 0, leg.tiePriority));
    });
  }
  return [...base.entries()]
    .map(([id, b]) => ({ id, score: decay ? b * decay(id) : b }))
    .sort((a, b) => b.score - a.score || priority.get(b.id)! - priority.get(a.id)! || a.id.localeCompare(b.id));
}

// Hybrid memory search (SPEC-P1.3): vector (pgvector cosine) + full-text ('simple' tsvector), fused via
// RRF — the same pattern as searchChunks. Memories are the PRIMARY object; vector-only recall missed
// exact names, codes, and rare tokens whose embeddings drift away from the query's.
// keyword=false -> pure vector + cosine threshold (legacy behavior).
export async function searchMemories({ sql, embed }: Ctx, opts: SearchOpts): Promise<MemoryResult[]> {
  const limit = clampLimit(opts.limit);
  const threshold = opts.threshold ?? Q.SIMILARITY_THRESHOLD;
  const useKeyword = opts.keyword !== false;
  const N = limit * Q.RESULTS_PER_QUERY;
  const [vec] = await embed({ values: [opts.q], taskType: "QUESTION_ANSWERING" });
  if (!vec) return [];
  const v = toVector(vec);
  const includeForgotten = !!opts.include?.forgottenMemories;
  // Shared by BOTH legs: visibility filters must not diverge between vector and keyword recall.
  const forgottenClause = includeForgotten
    ? sql``
    : sql`AND is_forgotten = false AND (forget_after IS NULL OR forget_after > now())`;
  const tagClause = opts.containerTag
    ? sql`AND space_id IN (SELECT id FROM space WHERE container_tag = ${opts.containerTag} AND org_id = ${ORG_ID})`
    : sql``;
  // The two legs are independent (D2): run them in parallel. The cosine floor applies to the VECTOR
  // leg only. Keyword hits are exempt: a literal text match is its own relevance evidence, and
  // ts_rank is not on the cosine scale (same rule as searchChunks).
  const [rawVrows, krows] = await Promise.all([
    sql`
      SELECT id, memory, version, created_at, 1 - (memory_embedding <=> ${v}::vector) AS similarity
      FROM memory_entry
      WHERE org_id = ${ORG_ID} AND is_latest = true AND memory_embedding IS NOT NULL
        ${forgottenClause} ${tagClause}
      ORDER BY memory_embedding <=> ${v}::vector
      LIMIT ${N}`,
    useKeyword
      ? sql`
          SELECT id, memory, version, created_at,
                 ts_rank(to_tsvector('simple', memory), websearch_to_tsquery('simple', ${opts.q})) AS rank
          FROM memory_entry
          WHERE org_id = ${ORG_ID} AND is_latest = true
            ${forgottenClause} ${tagClause}
            AND to_tsvector('simple', memory) @@ websearch_to_tsquery('simple', ${opts.q})
          ORDER BY rank DESC
          LIMIT ${N}`
      : Promise.resolve([] as any[]),
  ]);
  const toResult = (r: any, similarity: number, score: number): MemoryResult =>
    ({ type: "memory", id: r.id, memory: r.memory, version: Number(r.version), similarity, score });
  const vrows = rawVrows.filter((r) => Number(r.similarity) >= threshold);

  if (!useKeyword) return vrows.map((r) => toResult(r, Number(r.similarity), Number(r.similarity))).slice(0, limit);

  // Keyword-only hits carry similarity 0 (no cosine evidence, shape stays numeric).
  const data = new Map<string, MemoryResult>();
  const createdAt = new Map<string, number>();
  vrows.forEach((r) => { data.set(r.id, toResult(r, Number(r.similarity), 0)); createdAt.set(r.id, Date.parse(r.created_at)); });
  krows.forEach((r) => { if (!data.has(r.id)) data.set(r.id, toResult(r, 0, 0)); createdAt.set(r.id, Date.parse(r.created_at)); });

  // Recency decay (P1.2): fused = rrf × (1 − w·(1 − e^(−age/τ))). Multiplicative on the RANK-based
  // score, so it is scale-free and BOUNDED — an infinitely old memory keeps (1−w) of its relevance
  // (default 85%), it can lose a close race to a fresher near-match but is never buried outright.
  // recency:false (per request) or weight 0 (env) restores pure relevance order.
  const w = opts.recency === false ? 0 : recencyWeight();
  const tauMs = recencyTauDays() * 864e5;
  const now = Date.now();
  const decay = (id: string) => 1 - w * (1 - Math.exp(-Math.max(0, now - (createdAt.get(id) ?? now)) / tauMs));

  return rrfFuse(
    [
      { ids: vrows.map((r) => r.id), tiePriority: 0 },
      { ids: krows.map((r) => r.id), tiePriority: 1 }, // literal text evidence wins ties
    ],
    w === 0 ? undefined : decay,
  )
    .slice(0, limit)
    .map(({ id, score }) => ({ ...data.get(id)!, score }));
}

// Hybrid chunk search: vector (pgvector cosine) + full-text ('simple' tsvector), fused via RRF.
// keyword=false -> pure vector + cosine threshold (legacy behavior).
export async function searchChunks({ sql, embed }: Ctx, opts: SearchOpts): Promise<ChunkResult[]> {
  const limit = clampLimit(opts.limit);
  const threshold = opts.threshold ?? Q.SIMILARITY_THRESHOLD;
  const useKeyword = opts.keyword !== false;
  const N = limit * Q.RESULTS_PER_QUERY;
  const [vec] = await embed({ values: [opts.q], taskType: "QUESTION_ANSWERING" });
  if (!vec) return [];
  const v = toVector(vec);
  const tagClause = opts.containerTag
    ? sql`AND d.container_tags @> ARRAY[${opts.containerTag}]::text[]`
    : sql``;

  // Independent legs in parallel (D2). The cosine floor applies to the VECTOR leg on both paths
  // (it used to be skipped when keyword=true, silently letting sub-threshold vector hits through
  // RRF). Keyword hits are exempt: a literal text match is its own relevance evidence, and ts_rank
  // is not on the cosine scale.
  const [rawVrows, krows] = await Promise.all([
    sql`
      SELECT c.id, c.content, c.document_id, c.metadata, d.title, d.filepath,
             1 - (c.embedding <=> ${v}::vector) AS similarity
      FROM chunk c JOIN document d ON d.id = c.document_id
      WHERE d.org_id = ${ORG_ID} AND c.embedding IS NOT NULL ${tagClause}
      ORDER BY c.embedding <=> ${v}::vector
      LIMIT ${N}`,
    useKeyword
      ? sql`
          SELECT c.id, ts_rank(to_tsvector('simple', c.content), websearch_to_tsquery('simple', ${opts.q})) AS rank
          FROM chunk c JOIN document d ON d.id = c.document_id
          WHERE d.org_id = ${ORG_ID} ${tagClause}
            AND to_tsvector('simple', c.content) @@ websearch_to_tsquery('simple', ${opts.q})
          ORDER BY rank DESC
          LIMIT ${N}`
      : Promise.resolve([] as any[]),
  ]);
  const vrows = rawVrows.filter((r) => Number(r.similarity) >= threshold);

  if (!useKeyword) {
    return vrows
      .map((r): ChunkResult => ({ type: "chunk", id: r.id, content: r.content, similarity: Number(r.similarity), source: "vector",
        documentId: r.document_id, title: r.title ?? null, filepath: r.filepath ?? null, headingPath: (r.metadata?.headingPath as string) ?? null }))
      .slice(0, limit);
  }

  const inVec = new Set(vrows.map((r) => r.id));
  const inKw = new Set(krows.map((r) => r.id));
  const data = new Map<string, any>(vrows.map((r) => [r.id, r]));
  const topIds = rrfFuse([
    { ids: vrows.map((r) => r.id), tiePriority: 0 },
    { ids: krows.map((r) => r.id), tiePriority: 1 }, // literal text evidence wins ties
  ])
    .slice(0, limit)
    .map((e) => e.id);
  const missing = topIds.filter((id) => !data.has(id));
  if (missing.length) {
    const mrows = await sql`
      SELECT c.id, c.content, c.document_id, c.metadata, d.title, d.filepath, NULL::float AS similarity
      FROM chunk c JOIN document d ON d.id = c.document_id
      WHERE c.id = ANY(${missing}::text[])`;
    mrows.forEach((r) => data.set(r.id, r));
  }

  return topIds.map((id): ChunkResult => {
    const r = data.get(id);
    const source = inVec.has(id) && inKw.has(id) ? "both" : inKw.has(id) ? "keyword" : "vector";
    return { type: "chunk", id, content: r.content, similarity: r.similarity != null ? Number(r.similarity) : 0, source,
      documentId: r.document_id, title: r.title ?? null, filepath: r.filepath ?? null, headingPath: (r.metadata?.headingPath as string) ?? null };
  });
}

export async function search(ctx: Ctx, opts: SearchOpts): Promise<SearchResult[]> {
  const mode = opts.searchMode ?? "memories";
  if (mode === "documents") return searchChunks(ctx, opts);
  if (mode === "memories") return searchMemories(ctx, opts);
  // Hybrid mode fuses two lists whose scores live on DIFFERENT scales: memories carry raw cosine
  // similarity, chunks carry an RRF-derived ordering where keyword-only hits have similarity 0. Sorting
  // the union by raw similarity buried every keyword hit at the bottom — so fuse by RANK (RRF) instead,
  // which only assumes each list is ordered best-first.
  const limit = clampLimit(opts.limit);
  const [mem, chunks] = await Promise.all([searchMemories(ctx, opts), searchChunks(ctx, opts)]);
  const byKey = new Map<string, SearchResult>(
    [...mem, ...chunks].map((r) => [`${r.type}:${r.id}`, r]),
  );
  return rrfFuse([
    { ids: mem.map((r) => `memory:${r.id}`), tiePriority: 1 }, // memories are the primary object: they win cross-type ties
    { ids: chunks.map((r) => `chunk:${r.id}`), tiePriority: 0 },
  ])
    .slice(0, Math.min(limit, Q.MAX_COMBINED_RESULTS))
    .map(({ id }) => byKey.get(id)!);
}

export function searchRoutes(ctx: Ctx) {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SearchOpts;
    if (!body.q || typeof body.q !== "string") return c.json({ error: "q (string) is required" }, 400);

    const traceId = newId();
    const started = Date.now();
    let timedOut = false;
    try {
      const results = (await Promise.race([
        search(ctx, body),
        new Promise<SearchResult[]>((res) => setTimeout(() => { timedOut = true; res([]); }, Q.SEARCH_TIMEOUT_MS)),
      ])) as SearchResult[];
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "search",
        status: timedOut ? "timeout" : "ok",
        containerTag: body.containerTag,
        query: body.q,
        queries: [body.q],
        searchMode: body.searchMode ?? "memories",
        resultCount: results.length,
        latencyMs,
        retrieved: traceItemsFromSearchResults(results),
        request: {
          limit: body.limit,
          threshold: body.threshold,
          keyword: body.keyword,
          recency: body.recency,
          includeForgottenMemories: !!body.include?.forgottenMemories,
        },
      });
      c.header("x-bella-trace-id", traceId);
      c.header("x-bella-search-results", String(results.length));
      c.header("x-bella-search-latency-ms", String(latencyMs));
      return c.json({ results, traceId });
    } catch (e) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "search",
        status: "error",
        containerTag: body.containerTag,
        query: body.q,
        queries: [body.q],
        searchMode: body.searchMode ?? "memories",
        latencyMs,
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
      c.header("x-bella-trace-id", traceId);
      throw e;
    }
  });
  return app;
}
