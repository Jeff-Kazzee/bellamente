// search.ts - recall over memories (vector) and document chunks (hybrid: vector + full-text).
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { toVector, ORG_ID } from "./util";
import { DEFAULT_SIMILARITY_THRESHOLD } from "./embed-common";

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
  keyword?: boolean; // chunk search: fuse full-text leg (default true)
  include?: { forgottenMemories?: boolean };
};

export type MemoryResult = { type: "memory"; id: string; memory: string; version: number; similarity: number };
export type ChunkResult = {
  type: "chunk"; id: string; content: string; similarity: number; source: "vector" | "keyword" | "both";
  documentId: string; title: string | null; filepath: string | null; headingPath: string | null;
};
export type SearchResult = MemoryResult | ChunkResult;

const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 10, 1), 100);

export async function searchMemories({ sql, embed }: Ctx, opts: SearchOpts): Promise<MemoryResult[]> {
  const limit = clampLimit(opts.limit);
  const threshold = opts.threshold ?? Q.SIMILARITY_THRESHOLD;
  const [vec] = await embed({ values: [opts.q], taskType: "QUESTION_ANSWERING" });
  if (!vec) return [];
  const v = toVector(vec);
  const includeForgotten = !!opts.include?.forgottenMemories;
  const forgottenClause = includeForgotten
    ? sql``
    : sql`AND is_forgotten = false AND (forget_after IS NULL OR forget_after > now())`;
  const tagClause = opts.containerTag
    ? sql`AND space_id IN (SELECT id FROM space WHERE container_tag = ${opts.containerTag} AND org_id = ${ORG_ID})`
    : sql``;
  const rows = await sql`
    SELECT id, memory, version, 1 - (memory_embedding <=> ${v}::vector) AS similarity
    FROM memory_entry
    WHERE org_id = ${ORG_ID} AND is_latest = true AND memory_embedding IS NOT NULL
      ${forgottenClause} ${tagClause}
    ORDER BY memory_embedding <=> ${v}::vector
    LIMIT ${limit * Q.RESULTS_PER_QUERY}`;
  return rows
    .map((r): MemoryResult => ({ type: "memory", id: r.id, memory: r.memory, version: Number(r.version), similarity: Number(r.similarity) }))
    .filter((r) => r.similarity >= threshold)
    .slice(0, limit);
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

  const vrows = await sql`
    SELECT c.id, c.content, c.document_id, c.metadata, d.title, d.filepath,
           1 - (c.embedding <=> ${v}::vector) AS similarity
    FROM chunk c JOIN document d ON d.id = c.document_id
    WHERE d.org_id = ${ORG_ID} AND c.embedding IS NOT NULL ${tagClause}
    ORDER BY c.embedding <=> ${v}::vector
    LIMIT ${N}`;

  if (!useKeyword) {
    return vrows
      .map((r): ChunkResult => ({ type: "chunk", id: r.id, content: r.content, similarity: Number(r.similarity), source: "vector",
        documentId: r.document_id, title: r.title ?? null, filepath: r.filepath ?? null, headingPath: (r.metadata?.headingPath as string) ?? null }))
      .filter((r) => r.similarity >= threshold)
      .slice(0, limit);
  }

  const krows = await sql`
    SELECT c.id, ts_rank(to_tsvector('simple', c.content), websearch_to_tsquery('simple', ${opts.q})) AS rank
    FROM chunk c JOIN document d ON d.id = c.document_id
    WHERE d.org_id = ${ORG_ID} ${tagClause}
      AND to_tsvector('simple', c.content) @@ websearch_to_tsquery('simple', ${opts.q})
    ORDER BY rank DESC
    LIMIT ${N}`;

  // Reciprocal Rank Fusion
  const score = new Map<string, number>();
  const inVec = new Set<string>();
  const inKw = new Set<string>();
  const data = new Map<string, any>();
  vrows.forEach((r, i) => { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (Q.RRF_K + i + 1)); inVec.add(r.id); data.set(r.id, r); });
  krows.forEach((r, i) => { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (Q.RRF_K + i + 1)); inKw.add(r.id); });

  const topIds = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
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
  const limit = clampLimit(opts.limit);
  const [mem, chunks] = await Promise.all([searchMemories(ctx, opts), searchChunks(ctx, opts)]);
  return [...mem, ...chunks].sort((a, b) => b.similarity - a.similarity).slice(0, Math.min(limit, Q.MAX_COMBINED_RESULTS));
}

export function searchRoutes(ctx: Ctx) {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SearchOpts;
    if (!body.q || typeof body.q !== "string") return c.json({ error: "q (string) is required" }, 400);
    const results = (await Promise.race([
      search(ctx, body),
      new Promise<SearchResult[]>((res) => setTimeout(() => res([]), Q.SEARCH_TIMEOUT_MS)),
    ])) as SearchResult[];
    return c.json({ results });
  });
  return app;
}
