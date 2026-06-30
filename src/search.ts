// search.ts - recall (Spec 04, port of searchMemories).
import { Hono } from "hono";
import type { Db } from "./db";
import type { Embed } from "./embed";

type Ctx = { db: Db; embed: Embed };

export const Q = {
  RESULTS_PER_QUERY: 15,
  MAX_COMBINED_RESULTS: 25,
  SIMILARITY_THRESHOLD: Number(process.env.SEARCH_THRESHOLD ?? 0.4),
  SEARCH_TIMEOUT_MS: 10000,
  ENABLE_RERANK: false,
  ENABLE_QUERY_REWRITE: false,
};

export async function searchMemories(
  { db, embed }: Ctx,
  opts: { q: string; limit?: number; threshold?: number; containerTag?: string;
          include?: { forgottenMemories?: boolean } },
) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const threshold = opts.threshold ?? Q.SIMILARITY_THRESHOLD;
  const [vec] = await embed({ values: [opts.q], taskType: "QUESTION_ANSWERING" });
  void vec; void db;

  // TODO: pgvector cosine search:
  //   SELECT id, memory, 1 - (memory_embedding <=> $1) AS similarity
  //   FROM memory_entry
  //   WHERE is_latest = true
  //     AND (CASE WHEN $forgotten THEN true ELSE is_forgotten = false END)
  //     AND (forget_after IS NULL OR forget_after > now())
  //   ORDER BY memory_embedding <=> $1
  //   LIMIT limit * RESULTS_PER_QUERY;
  // then filter similarity >= threshold, dual-pass +0.1 recency boost, dedup, cap 25.
  return [] as Array<{ id: string; memory: string; similarity: number }>;
}

export function searchRoutes(ctx: Ctx) {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = await c.req.json();
    const results = await Promise.race([
      searchMemories(ctx, body),
      new Promise((res) => setTimeout(() => res([]), Q.SEARCH_TIMEOUT_MS)),
    ]);
    return c.json({ results });
  });
  return app;
}
