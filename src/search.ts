// search.ts - recall (Spec 04, port of searchMemories).
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
  include?: { forgottenMemories?: boolean };
};

export type SearchResult = { id: string; memory: string; version: number; similarity: number };

export async function searchMemories({ sql, embed }: Ctx, opts: SearchOpts): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const threshold = opts.threshold ?? Q.SIMILARITY_THRESHOLD;
  const [vec] = await embed({ values: [opts.q], taskType: "QUESTION_ANSWERING" });
  if (!vec) return [];
  const v = toVector(vec);

  // Build optional WHERE fragments (postgres.js composes nested sql fragments).
  const forgottenClause = opts.include?.forgottenMemories
    ? sql``
    : sql`AND is_forgotten = false AND (forget_after IS NULL OR forget_after > now())`;
  const tagClause = opts.containerTag
    ? sql`AND space_id IN (SELECT id FROM space WHERE container_tag = ${opts.containerTag} AND org_id = ${ORG_ID})`
    : sql``;

  // pgvector cosine: similarity = 1 - (embedding <=> query). HNSW orders by distance.
  const rows = await sql`
    SELECT id, memory, version, 1 - (memory_embedding <=> ${v}::vector) AS similarity
    FROM memory_entry
    WHERE org_id = ${ORG_ID}
      AND is_latest = true
      AND memory_embedding IS NOT NULL
      ${forgottenClause}
      ${tagClause}
    ORDER BY memory_embedding <=> ${v}::vector
    LIMIT ${limit * Q.RESULTS_PER_QUERY}`;

  return rows
    .map((r) => ({
      id: r.id as string,
      memory: r.memory as string,
      version: Number(r.version),
      similarity: Number(r.similarity),
    }))
    .filter((r) => r.similarity >= threshold)
    .slice(0, Q.MAX_COMBINED_RESULTS);
}

export function searchRoutes(ctx: Ctx) {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SearchOpts;
    if (!body.q || typeof body.q !== "string") return c.json({ error: "q (string) is required" }, 400);
    const results = (await Promise.race([
      searchMemories(ctx, body),
      new Promise<SearchResult[]>((res) => setTimeout(() => res([]), Q.SEARCH_TIMEOUT_MS)),
    ])) as SearchResult[];
    return c.json({ results });
  });
  return app;
}
