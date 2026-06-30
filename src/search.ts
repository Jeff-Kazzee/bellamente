// search.ts - recall over memories (Spec 04) and document chunks (RAG, Spec 05).
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { toVector, ORG_ID } from "./util";

type Ctx = { sql: DB; embed: Embed };

export const Q = {
  RESULTS_PER_QUERY: 15,
  MAX_COMBINED_RESULTS: 25,
  SIMILARITY_THRESHOLD: Number(process.env.SEARCH_THRESHOLD ?? 0.4),
  SEARCH_TIMEOUT_MS: 10000,
  ENABLE_RERANK: false,
  ENABLE_QUERY_REWRITE: false,
};

export type SearchOpts = {
  q: string;
  limit?: number;
  threshold?: number;
  containerTag?: string;
  searchMode?: "memories" | "documents" | "hybrid";
  include?: { forgottenMemories?: boolean };
};

export type MemoryResult = { type: "memory"; id: string; memory: string; version: number; similarity: number };
export type ChunkResult = {
  type: "chunk"; id: string; content: string; similarity: number;
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

export async function searchChunks({ sql, embed }: Ctx, opts: SearchOpts): Promise<ChunkResult[]> {
  const limit = clampLimit(opts.limit);
  const threshold = opts.threshold ?? Q.SIMILARITY_THRESHOLD;
  const [vec] = await embed({ values: [opts.q], taskType: "QUESTION_ANSWERING" });
  if (!vec) return [];
  const v = toVector(vec);
  const tagClause = opts.containerTag
    ? sql`AND d.container_tags @> ARRAY[${opts.containerTag}]::text[]`
    : sql``;
  const rows = await sql`
    SELECT c.id, c.content, c.document_id, c.metadata, d.title, d.filepath,
           1 - (c.embedding <=> ${v}::vector) AS similarity
    FROM chunk c
    JOIN document d ON d.id = c.document_id
    WHERE d.org_id = ${ORG_ID} AND c.embedding IS NOT NULL ${tagClause}
    ORDER BY c.embedding <=> ${v}::vector
    LIMIT ${limit * Q.RESULTS_PER_QUERY}`;
  return rows
    .map((r): ChunkResult => ({
      type: "chunk", id: r.id, content: r.content, similarity: Number(r.similarity),
      documentId: r.document_id, title: r.title ?? null, filepath: r.filepath ?? null,
      headingPath: (r.metadata?.headingPath as string) ?? null,
    }))
    .filter((r) => r.similarity >= threshold)
    .slice(0, limit);
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
