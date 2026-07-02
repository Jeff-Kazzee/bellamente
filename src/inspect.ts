// inspect.ts - local-only recall/injection trace logging and read API.
import { Hono } from "hono";
import type { DB } from "./db";
import { newId, ORG_ID } from "./util";
import { brandEnv } from "./env";

type Ctx = { sql: DB };

export type TraceItem = {
  type: string;
  id?: string;
  content?: string;
  contentLength?: number;
  truncated?: boolean;
  similarity?: number;
  source?: string;
  [key: string]: unknown;
};

export type TraceInput = {
  id?: string;
  kind: "search" | "proxy" | "tool_search" | string;
  status?: string;
  userId?: string;
  containerTag?: string;
  query?: string;
  queries?: string[];
  searchMode?: string;
  resultCount?: number;
  injectedCount?: number;
  latencyMs?: number;
  retrieved?: TraceItem[];
  injected?: TraceItem[];
  request?: unknown;
  metadata?: unknown;
};

const TRACE_TEXT_LIMIT = (() => {
  const raw = Number(brandEnv("TRACE_TEXT_LIMIT") ?? 1200);
  if (!Number.isFinite(raw) || raw <= 0) return 1200;
  return Math.min(Math.max(Math.round(raw), 80), 5000);
})();

// Read per-call (not frozen at import) so tests and live processes can tune retention.
function traceRetention(): number {
  const raw = Number(brandEnv("TRACE_RETENTION") ?? 1000);
  if (!Number.isFinite(raw)) return 1000;
  return Math.min(Math.max(Math.round(raw), 0), 100000);
}

function parseLimit(value: string | null | undefined): number {
  const n = Number(value ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.round(n), 1), 200);
}
const roundScore = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(6)) : undefined;

function clippedScalar(value: unknown): string {
  const text = String(value ?? "");
  return text.length > TRACE_TEXT_LIMIT ? text.slice(0, TRACE_TEXT_LIMIT) + "..." : text;
}

function clippedContent(value: unknown): Pick<TraceItem, "content" | "contentLength" | "truncated"> {
  const text = String(value ?? "");
  const truncated = text.length > TRACE_TEXT_LIMIT;
  return { content: clippedScalar(text), contentLength: text.length, truncated };
}

function clippedQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return clippedScalar(value);
}

function clippedQueries(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").map(clippedScalar) : [];
}

export function traceTextItem(type: string, content: unknown, extra: Record<string, unknown> = {}): TraceItem {
  return { type, ...clippedContent(content), ...extra };
}

export function traceItemFromSearchResult(result: any): TraceItem {
  if (result?.type === "memory") {
    return traceTextItem("memory", result.memory, {
      id: result.id,
      version: result.version,
      similarity: roundScore(result.similarity),
    });
  }
  if (result?.type === "chunk") {
    return traceTextItem("chunk", result.content, {
      id: result.id,
      similarity: roundScore(result.similarity),
      source: result.source,
      documentId: result.documentId,
      title: result.title,
      filepath: result.filepath,
      headingPath: result.headingPath,
    });
  }
  return traceTextItem("unknown", JSON.stringify(result ?? null));
}

export function traceItemsFromSearchResults(results: any[]): TraceItem[] {
  return results.map(traceItemFromSearchResult);
}

async function pruneTraceLog(sql: DB): Promise<void> {
  const retention = traceRetention();
  if (retention <= 0) return;
  await sql`
    DELETE FROM recall_trace
    WHERE org_id = ${ORG_ID}
      AND id NOT IN (
        SELECT id FROM recall_trace WHERE org_id = ${ORG_ID} ORDER BY created_at DESC LIMIT ${retention}
      )`;
}

// Pruning ran a full-table ORDER BY on EVERY trace write (review flag). Batch it: every PRUNE_EVERY
// writes per DB handle, so the table is bounded by retention + PRUNE_EVERY - 1 rows in the worst
// case. WeakMap keyed on the DB handle keeps test databases isolated from each other.
const PRUNE_EVERY = 25;
const writesSincePrune = new WeakMap<DB, number>();

export async function recordTrace(sql: DB, input: TraceInput): Promise<string> {
  const id = input.id ?? newId();
  await sql`
    INSERT INTO recall_trace
      (id, org_id, kind, status, user_id, container_tag, query, queries, search_mode,
       result_count, injected_count, latency_ms, retrieved, injected, request, metadata)
    VALUES
      (${id}, ${ORG_ID}, ${input.kind}, ${input.status ?? "ok"}, ${input.userId ?? null},
       ${input.containerTag ?? null}, ${clippedQuery(input.query)}, ${sql.json(clippedQueries(input.queries))},
       ${input.searchMode ?? null}, ${input.resultCount ?? input.retrieved?.length ?? 0},
       ${input.injectedCount ?? input.injected?.length ?? 0}, ${Math.max(0, Math.round(input.latencyMs ?? 0))},
       ${sql.json(input.retrieved ?? [])}, ${sql.json(input.injected ?? [])},
       ${sql.json(input.request ?? {})}, ${sql.json(input.metadata ?? {})})`;
  const writes = (writesSincePrune.get(sql) ?? 0) + 1;
  if (writes >= PRUNE_EVERY) {
    writesSincePrune.set(sql, 0);
    try {
      await pruneTraceLog(sql);
    } catch (e) {
      console.warn("[inspect] failed to prune trace log:", e instanceof Error ? e.message : String(e));
    }
  } else {
    writesSincePrune.set(sql, writes);
  }
  return id;
}

export async function recordTraceSafe(sql: DB, input: TraceInput): Promise<string> {
  const id = input.id ?? newId();
  try {
    await recordTrace(sql, { ...input, id });
  } catch (e) {
    console.warn("[inspect] failed to record trace:", e instanceof Error ? e.message : String(e));
  }
  return id;
}

function normalizeTrace(row: any) {
  const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    userId: row.user_id ?? null,
    containerTag: row.container_tag ?? null,
    query: row.query ?? null,
    queries: row.queries ?? [],
    searchMode: row.search_mode ?? null,
    resultCount: Number(row.result_count ?? 0),
    injectedCount: Number(row.injected_count ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    retrieved: row.retrieved ?? [],
    injected: row.injected ?? [],
    request: row.request ?? {},
    metadata: row.metadata ?? {},
    createdAt: Number.isNaN(created.getTime()) ? String(row.created_at) : created.toISOString(),
  };
}

async function getTrace(sql: DB, id: string) {
  const rows = await sql`SELECT * FROM recall_trace WHERE org_id = ${ORG_ID} AND id = ${id} LIMIT 1`;
  return rows[0] ? normalizeTrace(rows[0]) : null;
}

export function inspectRoutes({ sql }: Ctx) {
  const app = new Hono();

  app.get("/", async (c) => {
    const traceId = c.req.query("traceId");
    if (traceId) {
      const trace = await getTrace(sql, traceId);
      if (!trace) return c.json({ error: "TraceNotFound" }, 404);
      return c.json({ trace });
    }

    const limit = parseLimit(c.req.query("limit"));
    const kind = c.req.query("kind");
    const kindClause = kind ? sql`AND kind = ${kind}` : sql``;
    const rows = await sql`
      SELECT * FROM recall_trace
      WHERE org_id = ${ORG_ID} ${kindClause}
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return c.json({ traces: rows.map(normalizeTrace) });
  });

  app.get("/:id", async (c) => {
    const trace = await getTrace(sql, c.req.param("id"));
    if (!trace) return c.json({ error: "TraceNotFound" }, 404);
    return c.json({ trace });
  });

  return app;
}
