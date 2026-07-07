// mcp.ts - `bella mcp`: stdio MCP server exposing 6 memory tools (SPEC-P1.7, issue #42).
// Every tool is a THIN WRAPPER over the SAME underlying functions/routes the HTTP API uses — no
// second DB writer, no duplicated query logic. Pure + testable: no stdio, no process (that lives in
// runMcpStdio / the `bella mcp` subcommand in index.ts).
//
// memory_list, memory_forget, and trace_inspect reuse the exact Hono route handlers
// (memoriesRoutes/inspectRoutes) via `.request()` — the same pattern this repo's own tests use
// (capture.test.ts, documents.test.ts) — because those three read paths are not exported as
// standalone functions, only as routes. memory_search and memory_write and document_ingest reuse
// the exported service functions directly (search/writeMemories/ingestDocument).
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { search, type SearchResult } from "./search";
import { writeMemories, memoriesRoutes } from "./memories";
import { ingestDocument, documentsRoutes, MAX_CONTENT_CHARS } from "./documents";
import { inspectRoutes, recordTraceSafe, traceItemsFromSearchResults } from "./inspect";
import { newId, DEFAULT_CONTAINER_TAG } from "./util";

type Ctx = { sql: DB; embed: Embed };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] });
const fail = (error: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true });

// {type,id,text,similarity} per SPEC-P1.7 — "text" generalizes memory.memory / chunk.content so
// callers don't need to branch on result type to read the recalled text.
function toToolResult(r: SearchResult): { type: "memory" | "chunk"; id: string; text: string; similarity: number } {
  return r.type === "memory"
    ? { type: "memory", id: r.id, text: r.memory, similarity: r.similarity }
    : { type: "chunk", id: r.id, text: r.content, similarity: r.similarity };
}

async function jsonOf(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

export function makeMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "bellamente", version: "0.0.1" });

  // Built once per server: same ctx.sql as every other tool (and as `bella serve`'s HTTP routes) —
  // there is no second DB connection anywhere in this module (B8).
  const memApp = memoriesRoutes(ctx);
  const inspectApp = inspectRoutes({ sql: ctx.sql });
  const docApp = documentsRoutes(ctx);

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Search Bellamente memories and/or ingested documents (vector + keyword hybrid recall). " +
        "Every call is recorded as a recall trace inspectable via trace_inspect.",
      inputSchema: {
        query: z.string().min(1).describe("what to recall"),
        searchMode: z.enum(["memories", "documents", "hybrid"]).default("memories"),
        containerTag: z.string().min(1).default(DEFAULT_CONTAINER_TAG),
        limit: z.number().int().positive().max(100).default(10),
      },
    },
    async ({ query, searchMode, containerTag, limit }) => {
      const traceId = newId();
      const started = Date.now();
      try {
        const results = await search(ctx, { q: query, searchMode, containerTag, limit });
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "search",
          status: "ok",
          containerTag,
          query,
          queries: [query],
          searchMode,
          resultCount: results.length,
          latencyMs: Date.now() - started,
          retrieved: traceItemsFromSearchResults(results),
          request: { limit, containerTag },
        });
        return ok({ results: results.map(toToolResult) });
      } catch (e) {
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "search",
          status: "error",
          containerTag,
          query,
          queries: [query],
          searchMode,
          latencyMs: Date.now() - started,
          request: { limit, containerTag },
          metadata: { error: msg(e) },
        });
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "Write memory",
      description:
        "Store a durable fact. Exact re-submissions are no-ops; near-duplicates supersede as a new " +
        "version (the old version stays inspectable) — same dedup/supersede path as the HTTP API.",
      inputSchema: {
        content: z.string().min(1).max(10000),
        // OPTIONAL, not default(false): a default makes isStatic always "provided" to writeMemories, which
        // routes an exact re-submission into the "updated" branch instead of "unchanged". Omitted => stored
        // as non-static, same as false, but a bare resubmit is correctly a no-op.
        isStatic: z.boolean().optional(),
        containerTag: z.string().min(1).default(DEFAULT_CONTAINER_TAG),
      },
    },
    async ({ content, isStatic, containerTag }) => {
      try {
        const { results } = await writeMemories(ctx, {
          containerTag,
          documentSource: "mcp",
          items: [{ content, isStatic }],
        });
        const r = results[0];
        if (!r) return fail("write produced no result (content may have failed to embed)");
        // A lost version race (external pooled Postgres only — PGlite serializes whole transactions)
        // writes NO row. Mirror the HTTP route (memories.ts POST /): emit a shape that does NOT imply an
        // id->stored-memory mapping. `attemptedContent` was NOT stored; `conflictWith` is the contested
        // chain to re-read before retrying just this write. Returning `{id, action}` here would mislabel
        // an unrelated chain id as the new memory and drop the retry signal.
        if (r.action === "conflict") {
          return ok({ action: "conflict", retryable: true, attemptedContent: r.content, conflictWith: r.id });
        }
        // Surface any credential redaction so the agent knows its content was stored with a secret stripped.
        return ok({ id: r.id, action: r.action, ...(r.redacted.length ? { redacted: r.redacted } : {}) });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "memory_correct",
    {
      title: "Correct a specific memory",
      description:
        "Change ONE existing memory (by id) to new text, recording it as a NEW VERSION in that memory's " +
        "history — the previous text stays inspectable via memory_history. Use this when you know which " +
        "memory to fix (get the id from memory_search or memory_list): unlike memory_write, it ALWAYS " +
        "targets that exact memory and never risks storing the change as a separate near-duplicate. Only " +
        "the current (latest) version can be corrected.",
      inputSchema: {
        id: z.string().min(1),
        content: z.string().min(1).max(10000),
      },
    },
    async ({ id, content }) => {
      try {
        // Reuses the exact PATCH /:id route handler (memories.ts) — a content change writes a new version
        // (chain preserved), same path the HTTP API / dashboard edit uses. Deterministic: no similarity
        // threshold involved, so it never mis-files a correction as a separate memory.
        const res = await memApp.request(`/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const json = await jsonOf(res);
        if (!res.ok) return fail(json?.error ?? `correct failed with HTTP ${res.status}`);
        return ok(json);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Forget memory",
      description:
        "Soft-forget a memory's whole version chain (excluded from search, NOT physically deleted). " +
        "Pass undo:true to restore it. This tool can never hard-delete — that path is intentionally " +
        "not wired into MCP.",
      inputSchema: {
        id: z.string().min(1),
        undo: z.boolean().default(false),
      },
    },
    async ({ id, undo }) => {
      try {
        // Reuses the exact POST /:id/forget route handler (memories.ts) — reversible soft-forget only;
        // DELETE /:id (the hard-delete route) is deliberately never called from this module.
        const res = await memApp.request(`/${encodeURIComponent(id)}/forget`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ undo }),
        });
        const json = await jsonOf(res);
        if (!res.ok) return fail(json?.error ?? `forget failed with HTTP ${res.status}`);
        return ok(json);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memories",
      description:
        "List the latest, non-forgotten memories (newest first). " +
        "Pass containerTag to scope the list to a single container (space).",
      inputSchema: {
        limit: z.number().int().positive().max(100).default(50),
        containerTag: z.string().min(1).optional(),
      },
    },
    async ({ limit, containerTag }) => {
      try {
        // Reuses the exact GET / route handler (memories.ts) — same list-latest query the dashboard uses.
        const qs = new URLSearchParams({ limit: String(limit) });
        if (containerTag) qs.set("containerTag", containerTag);
        const res = await memApp.request(`/?${qs.toString()}`);
        const json = await jsonOf(res);
        if (!res.ok) return fail(json?.error ?? `list failed with HTTP ${res.status}`);
        return ok(json);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "document_ingest",
    {
      title: "Ingest document",
      description:
        "Chunk + embed a markdown/text document so it becomes searchable via memory_search " +
        "(searchMode: documents|hybrid).",
      inputSchema: {
        content: z.string().min(1).max(MAX_CONTENT_CHARS),
        title: z.string().default("Untitled"),
        filepath: z.string().optional(),
        containerTag: z.string().min(1).default(DEFAULT_CONTAINER_TAG),
      },
    },
    async ({ content, title, filepath, containerTag }) => {
      try {
        // Mirror the HTTP route: a blank/whitespace title normalizes to "Untitled" (documents.ts POST /).
        const { documentId, chunkCount } = await ingestDocument(ctx, { content, title: title.trim() || "Untitled", filepath, containerTag });
        return ok({ documentId, chunkCount });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "trace_inspect",
    {
      title: "Inspect recall traces",
      description:
        "Read the recall-trace log (why a given search returned what it did): pass traceId for one full " +
        "trace, or omit it for the most recent traces. Each trace records the query, the retrieved items " +
        "with similarity scores, latency, container, and search mode. Pass kind to filter the list " +
        "(e.g. 'search' for tool/API searches, 'proxy' for chat-proxy memory injections).",
      inputSchema: {
        traceId: z.string().min(1).optional(),
        kind: z.string().min(1).optional().describe("filter the list by trace kind, e.g. 'search' or 'proxy'"),
        limit: z.number().int().positive().max(200).default(20),
      },
    },
    async ({ traceId, kind, limit }) => {
      try {
        // Reuses the exact GET /:id and GET / route handlers (inspect.ts) — same trace store the
        // dashboard's Traces view reads. The list route honors ?kind= for filtering.
        const listQs = new URLSearchParams({ limit: String(limit) });
        if (kind) listQs.set("kind", kind);
        const res = traceId
          ? await inspectApp.request(`/${encodeURIComponent(traceId)}`)
          : await inspectApp.request(`/?${listQs.toString()}`);
        const json = await jsonOf(res);
        if (!res.ok) return fail(json?.error ?? `trace lookup failed with HTTP ${res.status}`);
        return ok(json);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "memory_history",
    {
      title: "Memory history (version chain)",
      description:
        "Show the full version history of ONE memory by id: every correction as its own version " +
        "(oldest → newest), which one is current (isLatest), whether the chain is forgotten, plus " +
        "validity windows and timestamps. This is the inspect-and-trust view — nothing is hidden " +
        "(forgotten versions are included). Answers \"what did this used to say / how did it change?\". " +
        "Get an id from memory_search or memory_list.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        // Reuses the exact GET /:id route handler (memories.ts) — the same full-version-chain read the
        // dashboard's history view uses. Returns { memory: <current row>, versions: [<whole chain>] }.
        const res = await memApp.request(`/${encodeURIComponent(id)}`);
        const json = await jsonOf(res);
        if (!res.ok) return fail(json?.error ?? `history lookup failed with HTTP ${res.status}`);
        return ok(json);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "document_list",
    {
      title: "List ingested documents",
      description:
        "List documents ingested via document_ingest (newest first): id, title, chunk count, container " +
        "tags, and created time — metadata only, not the text. Answers \"what documents do I have?\". " +
        "To read a document's content, search it with memory_search (searchMode: documents).",
      inputSchema: {
        limit: z.number().int().positive().max(200).default(50),
      },
    },
    async ({ limit }) => {
      try {
        // Reuses the exact GET / route handler (documents.ts) — same list the dashboard's Documents view
        // uses. (The route lists all org documents newest-first; it does not filter by container, so this
        // tool intentionally exposes no containerTag param rather than a no-op one.)
        const res = await docApp.request(`/?limit=${limit}`);
        const json = await jsonOf(res);
        if (!res.ok) return fail(json?.error ?? `document list failed with HTTP ${res.status}`);
        return ok(json);
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  return server;
}

// Connects the registered server to real stdin/stdout. `bella mcp` (src/index.ts) calls this AFTER
// redirecting console.log/info/debug to stderr — stdout is the JSON-RPC channel here, and any stray
// diagnostic byte on it corrupts the protocol (SPEC-P1.7 CRITICAL note).
export async function runMcpStdio(ctx: Ctx): Promise<void> {
  const server = makeMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}
