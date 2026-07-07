// proxy-tool-round.ts - memory tool search and result merging shared by proxy modes.
import type { DB } from "./db";
import type { Embed } from "./embed";
import { recordTraceSafe, traceItemsFromSearchResults } from "./inspect";
import { capture } from "./observe";
import { searchMemories, rrfFuse, Q, type MemoryResult } from "./search";
import { MAX_QUERIES_PER_CALL } from "./proxy-tool";

type ToolSearchCtx = { sql: DB; embed: Embed };

export type ToolSearchTraceOpts = {
  traceId?: string;
  userId?: string;
  containerTag?: string;
  recordTrace?: boolean;
};

export type MemoryToolRound = {
  toolMessages: any[];
  // Per-tool-call result batches, boundaries kept: the final injection merge fuses them by rank
  // (topMemoryResults), which needs each batch's internal (diversified) order intact.
  allBatches: MemoryResult[][];
  usedQueries: string[];
  toolSearchTimedOut: boolean;
  toolSearchFailed: boolean;
  toolSearchError?: string;
};

// Run up to MAX_QUERIES_PER_CALL searches, merge via topMemoryResults (the ONE merge/cap rule).
export async function runToolSearch(ctx: ToolSearchCtx, queries: string[], opts: ToolSearchTraceOpts = {}) {
  const started = Date.now();
  const capped = queries.slice(0, MAX_QUERIES_PER_CALL);
  try {
    const batches = await Promise.all(capped.map((q) => searchMemories(ctx, { q, containerTag: opts.containerTag })));
    const results = topMemoryResults(batches);

    if (opts.recordTrace !== false) {
      const items = traceItemsFromSearchResults(results);
      await recordTraceSafe(ctx.sql, {
        id: opts.traceId,
        kind: "tool_search",
        status: "ok",
        userId: opts.userId,
        containerTag: opts.containerTag,
        query: capped[0],
        queries: capped,
        searchMode: "memories",
        resultCount: results.length,
        injectedCount: results.length,
        latencyMs: Date.now() - started,
        retrieved: items,
        injected: items,
        request: { maxQueries: MAX_QUERIES_PER_CALL, maxResults: Q.MAX_COMBINED_RESULTS },
      });
    }

    return results;
  } catch (e) {
    if (opts.recordTrace !== false) {
      await recordTraceSafe(ctx.sql, {
        id: opts.traceId,
        kind: "tool_search",
        status: "error",
        userId: opts.userId,
        containerTag: opts.containerTag,
        query: capped[0],
        queries: capped,
        latencyMs: Date.now() - started,
        metadata: { error: e instanceof Error ? e.message : String(e) },
      });
    }
    throw e;
  }
}

function toolResultPayload(queries: string[], results: MemoryResult[], error?: string) {
  return {
    type: "bella_memory_results",
    queries,
    ...(error ? { error } : {}),
    results: results.map((r) => ({
      type: r.type,
      id: r.id,
      content: r.memory,
      version: r.version,
      similarity: Number(r.similarity.toFixed(6)),
    })),
  };
}

// INVARIANT: every input batch must come from the keyword-default search path. `score` is
// RRF-scale (~0.016) there but raw-cosine-scale (~1.0) on keyword:false - mixing the two in the
// max-by-score dedupe would silently bias toward the cosine-scale batch. Merge across batches by
// RANK (rrfFuse), never by score: each batch's order is MMR-diversified, so a score re-sort would
// put the near-duplicates right back on top. A single batch passes through in its own order.
export function topMemoryResults(batches: MemoryResult[][]): MemoryResult[] {
  const merged = new Map<string, MemoryResult>();
  for (const batch of batches) {
    for (const result of batch) {
      const prev = merged.get(result.id);
      if (!prev || result.score > prev.score) merged.set(result.id, result);
    }
  }
  return rrfFuse(batches.map((b) => ({ ids: b.map((r) => r.id), tiePriority: 0 })))
    .slice(0, Q.MAX_COMBINED_RESULTS)
    .map(({ id }) => merged.get(id)!);
}

// One memory tool round: run the model's searchMemory calls under a shared per-turn query budget and
// build the role:"tool" result messages. Shared by the buffered and streamed paths so degradation
// semantics (timeout -> empty results, failure -> empty results + memory_search_unavailable) stay identical.
export async function runMemoryToolRound(
  ctx: ToolSearchCtx,
  calls: { id: string; queries: string[] }[],
  opts: { userId?: string; containerTag?: string },
): Promise<MemoryToolRound> {
  let remainingQueries = MAX_QUERIES_PER_CALL;
  let toolSearchTimedOut = false;
  let toolSearchFailed = false;
  let toolSearchError: string | undefined;
  const toolMessages: any[] = [];
  const allBatches: MemoryResult[][] = [];
  const usedQueries: string[] = [];
  for (const call of calls) {
    const queries = call.queries.slice(0, Math.max(remainingQueries, 0));
    remainingQueries -= queries.length;
    usedQueries.push(...queries);
    let results: MemoryResult[] = [];
    let failed = false;
    if (queries.length) {
      let timedOut = false;
      const searchPromise = runToolSearch(ctx, queries, { userId: opts.userId, containerTag: opts.containerTag, recordTrace: false }).catch((e) => {
        if (timedOut) {
          console.warn("[proxy] memory tool search finished after timeout:", e instanceof Error ? e.message : String(e));
          return [];
        }
        throw e;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        results = await Promise.race([
          searchPromise,
          new Promise<MemoryResult[]>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              toolSearchTimedOut = true;
              resolve([]);
            }, Q.SEARCH_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        failed = true;
        toolSearchFailed = true;
        toolSearchError = e instanceof Error ? e.message : String(e);
        // A swallowed failure that used to vanish behind a raw console.warn now flows through the
        // redacted capture funnel (nothing fails silently, and no user content is logged).
        capture(e, { category: "proxy", code: "TOOL_SEARCH_FAILED", component: "memory-tool-round" });
        results = [];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (results.length) allBatches.push(results);
    toolMessages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(toolResultPayload(queries, results, failed ? "memory_search_unavailable" : undefined)),
    });
  }
  return { toolMessages, allBatches, usedQueries, toolSearchTimedOut, toolSearchFailed, ...(toolSearchError ? { toolSearchError } : {}) };
}
