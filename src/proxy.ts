// proxy.ts - Chat Completions-compatible interceptor. Injects a memory-search tool + user context.
import { Hono } from "hono";
import { isIP } from "node:net";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { searchMemories, Q, type MemoryResult } from "./search";
import { formatProfile, profileContextBlock, loadProfile } from "./profile";
import { DEFAULT_CONTAINER_TAG, newId } from "./util";
import { brandEnv } from "./env";
import { captureFromTurn } from "./capture";
import { recordTraceSafe, traceItemsFromSearchResults, traceTextItem } from "./inspect";

type FetchLike = typeof fetch;
type Ctx = {
  sql: DB;
  embed: Embed;
  fetch?: FetchLike;
  upstreamBaseUrl?: string;
  upstreamApiKey?: string;
  allowUnauthenticatedUpstream?: boolean;
};

export const MEMORY_TOOL_NAME = "searchMemory";
export const MIN_QUERIES_PER_CALL = 1;
export const MAX_QUERIES_PER_CALL = 5;

type ToolSearchTraceOpts = {
  traceId?: string;
  userId?: string;
  containerTag?: string;
  recordTrace?: boolean;
};

const MEMORY_TOOL_DESCRIPTION =
  "Look up the user's saved memories and documents whenever you need context you do not already have - their preferences, facts about them, earlier conversations, or material they have stored. Call this at most once per turn: put every question you want answered into the `queries` array in a single call instead of invoking the tool repeatedly.";

const MEMORY_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      items: { type: "string" },
      description:
        "One or more search phrases to look up. Include every query you need here, because the tool runs only once per turn.",
      minItems: MIN_QUERIES_PER_CALL,
      maxItems: MAX_QUERIES_PER_CALL,
    },
  },
  required: ["queries"],
};

// One call per turn; batch all needed memory lookups into the queries array.
export function toolDescription() {
  return {
    name: MEMORY_TOOL_NAME,
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: MEMORY_TOOL_PARAMETERS,
  };
}

function chatCompletionsToolDefinition() {
  return { type: "function", function: toolDescription() };
}

// Run up to MAX_QUERIES_PER_CALL searches, merge by id keep max similarity, cap MAX_COMBINED_RESULTS.
export async function runToolSearch(ctx: Ctx, queries: string[], opts: ToolSearchTraceOpts = {}) {
  const started = Date.now();
  const capped = queries.slice(0, MAX_QUERIES_PER_CALL);
  try {
    const batches = await Promise.all(capped.map((q) => searchMemories(ctx, { q, containerTag: opts.containerTag })));
    const merged = new Map<string, MemoryResult>();
    for (const batch of batches) {
      for (const r of batch) {
        const prev = merged.get(r.id);
        if (!prev || r.similarity > prev.similarity) merged.set(r.id, r);
      }
    }
    const results = Array.from(merged.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Q.MAX_COMBINED_RESULTS);

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
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as any).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// The proxy speaks Chat Completions ONLY. It used to half-parse Anthropic-Messages shapes here
// (top-level body.system, content blocks with type:"tool_result") that the tool-call round trip could
// never actually serve — dead code that misled readers into thinking Anthropic was supported. Removed;
// Anthropic support is a BACKLOG decision (docs/BACKLOG.md P2.2), not an accident of parsing.
function promptText(body: any): string | undefined {
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    const text = contentText(m?.content);
    if (text) parts.push(`${m?.role ?? "message"}: ${text}`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

function requestSummary(body: any) {
  return {
    model: typeof body.model === "string" ? body.model : null,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    hasSystem: (body.messages ?? []).some((m: any) => m?.role === "system"),
    stream: body.stream === true,
  };
}

function hasToolResults(body: any): boolean {
  return (body.messages ?? []).some((m: any) => m?.role === "tool");
}

function toolName(tool: any): string | undefined {
  return typeof tool?.function?.name === "string" ? tool.function.name : typeof tool?.name === "string" ? tool.name : undefined;
}

function injectMemoryTool(body: any): boolean {
  body.tools = Array.isArray(body.tools) ? body.tools : [];
  const existing = body.tools.findIndex((t: any) => toolName(t) === MEMORY_TOOL_NAME);
  if (existing >= 0) {
    const tool = body.tools[existing];
    if (tool?.type !== "function" || !tool?.function) body.tools[existing] = chatCompletionsToolDefinition();
    return true;
  }
  body.tools.unshift(chatCompletionsToolDefinition());
  return false;
}

function injectProfileBlock(body: any, block: string) {
  const system = body.messages.find((m: any) => m?.role === "system");
  if (!system) {
    body.messages.unshift({ role: "system", content: block.trim() });
  } else if (typeof system.content === "string") {
    system.content += block;
  } else if (Array.isArray(system.content)) {
    system.content.push({ type: "text", text: block.trim() });
  } else {
    system.content = block.trim();
  }
}

type UpstreamConfig =
  | { ok: true; url: string; headers: Headers }
  | { ok: false; error: string; status: number; upstreamBase?: string };

function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isIpv4Loopback(host: string): boolean {
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}

function hexWord(word: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(word)) return null;
  const value = Number.parseInt(word, 16);
  return Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
}

function isIpv4MappedLoopback(host: string): boolean {
  if (isIP(host) !== 6 || !host.startsWith("::ffff:")) return false;
  const mapped = host.slice("::ffff:".length);
  if (isIpv4Loopback(mapped)) return true;

  const words = mapped.split(":");
  if (words.length !== 2) return false;
  const highWord = hexWord(words[0]);
  const lowWord = hexWord(words[1]);
  if (highWord == null || lowWord == null) return false;
  return highWord >> 8 === 127;
}

function isLoopbackUpstream(url: URL): boolean {
  const host = normalizedHostname(url);
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || isIpv4Loopback(host) || isIpv4MappedLoopback(host);
}

function upstreamConfig(c: any, ctx: Ctx): UpstreamConfig {
  const base = ctx.upstreamBaseUrl || brandEnv("UPSTREAM_BASE_URL") || "http://127.0.0.1:11434/v1";
  let parsed: URL;
  try {
    parsed = new URL(chatCompletionsUrl(base));
  } catch {
    return { ok: false, status: 400, error: "Invalid upstream base URL", upstreamBase: base };
  }
  const url = parsed.toString();

  const explicitAuth = c.req.header("x-bella-upstream-authorization");
  const apiKey = c.req.header("x-bella-upstream-api-key") || ctx.upstreamApiKey || brandEnv("UPSTREAM_API_KEY") || "";
  const allowNoAuth = ctx.allowUnauthenticatedUpstream || brandEnv("UPSTREAM_ALLOW_NO_AUTH") === "1" || isLoopbackUpstream(parsed);
  if (!explicitAuth && !apiKey && !allowNoAuth) {
    return {
      ok: false,
      status: 502,
      error: "Missing upstream API key for non-local upstream. Set BELLA_UPSTREAM_API_KEY, send x-bella-upstream-api-key, or point BELLA_UPSTREAM_BASE_URL at a local server.",
      upstreamBase: base,
    };
  }

  const headers = new Headers({ "content-type": "application/json" });
  if (explicitAuth) headers.set("authorization", explicitAuth);
  else if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  return { ok: true, url, headers };
}

// Upstream timeouts. Read lazily (per request, not at import) so tests and long-running processes can
// adjust without a restart. Bounded [1ms, 10min]; local LLM generation can legitimately take minutes,
// so the buffered default is generous — the point is "never hang forever", not "be snappy".
const clampMs = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 600_000);
};
export function upstreamTimeoutMs(): number {
  return clampMs(brandEnv("UPSTREAM_TIMEOUT_MS"), 120_000);
}
export function streamIdleTimeoutMs(): number {
  return clampMs(brandEnv("STREAM_IDLE_TIMEOUT_MS"), 120_000);
}

// One deadline covers connect + headers + (for buffered exchanges) the full body read: fetch's abort
// signal governs res.text() too, so a stalled body can't hang past the deadline. Streaming call sites
// clear the deadline once headers arrive and hand off to the per-read idle timeout in proxyStreamResponse.
type Deadline = { signal: AbortSignal; clear: () => void };
function upstreamDeadline(ms: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`upstream timed out after ${ms}ms (BELLA_UPSTREAM_TIMEOUT_MS)`)),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function forwardUpstream(
  fetcher: FetchLike,
  config: Extract<UpstreamConfig, { ok: true }>,
  body: any,
  signal?: AbortSignal,
) {
  return fetcher(config.url, { method: "POST", headers: config.headers, body: JSON.stringify(body), signal });
}

async function readUpstreamBody(res: Response): Promise<{ text: string; json: any }> {
  const text = await res.text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

// fetch() wraps abort reasons in a TypeError whose `cause` holds the real deadline error — unwrap it so
// traces say "timed out after Nms" instead of "fetch failed".
function upstreamErrorMessage(e: unknown): string {
  const cause = (e as any)?.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return e instanceof Error ? e.message : String(e);
}

// Buffered request/response exchange under one deadline. Fetch errors, timeouts, and mid-body read
// failures all land in the same { ok: false } shape — call sites treat them as one upstream_error path.
type BufferedExchange =
  | { ok: true; res: Response; text: string; json: any }
  | { ok: false; error: string };
async function bufferedUpstreamExchange(
  fetcher: FetchLike,
  config: Extract<UpstreamConfig, { ok: true }>,
  body: any,
): Promise<BufferedExchange> {
  const deadline = upstreamDeadline(upstreamTimeoutMs());
  try {
    const res = await forwardUpstream(fetcher, config, body, deadline.signal);
    const { text, json } = await readUpstreamBody(res);
    return { ok: true, res, text, json };
  } catch (e) {
    return { ok: false, error: upstreamErrorMessage(e) };
  } finally {
    deadline.clear();
  }
}

function parseToolArgs(value: unknown): string[] {
  let parsed: any = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "{}");
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed?.queries)
    ? parsed.queries
        .filter((q: unknown): q is string => typeof q === "string")
        .map((q: string) => q.trim())
        .filter(Boolean)
    : [];
}

function firstToolCallMessage(upstreamJson: any): any | null {
  const message = upstreamJson?.choices?.[0]?.message;
  return message && Array.isArray(message.tool_calls) ? message : null;
}

function isMemoryToolCall(call: any): boolean {
  return (!call?.type || call.type === "function") && call?.function?.name === MEMORY_TOOL_NAME;
}

function externalToolCalls(upstreamJson: any): any[] {
  const message = firstToolCallMessage(upstreamJson);
  return message ? message.tool_calls.filter((call: any) => !isMemoryToolCall(call)) : [];
}

function firstMemoryToolCalls(upstreamJson: any): { id: string; queries: string[]; assistantMessage: any }[] {
  const message = firstToolCallMessage(upstreamJson);
  if (!message) return [];
  const calls: { id: string; queries: string[]; assistantMessage: any }[] = [];
  for (const call of message.tool_calls) {
    if (!isMemoryToolCall(call)) continue;
    const queries = parseToolArgs(call.function.arguments);
    calls.push({ id: String(call.id || newId()), queries, assistantMessage: message });
  }
  return calls;
}

// Streamed equivalent of firstMemoryToolCalls/externalToolCalls: read the upstream SSE stream just far
// enough to classify the turn. `function.arguments` arrives as string FRAGMENTS spread across delta
// chunks (often split mid-JSON), so fragments accumulate per tool-call index and only the concatenated
// whole is parsed. Every raw chunk read here is kept in `held` so answer/external decisions can replay
// the bytes to the client unmodified.
type StreamDecision =
  | { decision: "answer"; held: Uint8Array[] }
  | { decision: "external_tool"; held: Uint8Array[] }
  | { decision: "memory_tool"; held: Uint8Array[]; assistantMessage: any; memoryCalls: { id: string; queries: string[] }[] };

// Structural reader type: Bun's getReader() returns a reader with extras (readMany) that the DOM
// ReadableStreamDefaultReader<Uint8Array> type doesn't unify with under tsc.
type ByteStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown> | void;
};

// Local models often emit PREAMBLE content ("Let me check…") before their searchMemory call in the
// same choice. Committing to "answer" on the first content token would leak that tool call to a
// client that cannot serve it and silently skip memory grounding (the buffered path intercepts it
// regardless of content). So content is HELD until finish_reason/[DONE] — or until this many chars
// arrive with no tool-call fragment, at which point it is safe to assume a plain answer and start
// piping live. 0 = commit on the very first content token (no hold, maximum streaming latency win,
// preamble tool calls leak). Bounded [0, 100k].
export function streamDecisionHoldChars(): number {
  const raw = brandEnv("STREAM_DECISION_HOLD_CHARS");
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n < 0) return 512;
  return Math.min(Math.round(n), 100_000);
}

// Runaway guard: a stream that never yields a decision (e.g. endless keepalive comments) must not
// grow `held` unbounded. Past this many held bytes the turn is committed as a plain answer and
// replayed — degraded, but bounded.
const DECISION_HELD_BYTES_CAP = 1_048_576;

async function readStreamDecision(reader: ByteStreamReader, idleMs: number): Promise<StreamDecision> {
  const held: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let heldBytes = 0;
  let contentChars = 0;
  const holdChars = streamDecisionHoldChars();
  const calls = new Map<number, { id?: string; name?: string; args: string }>();
  // Deltas that omit `index` but carry an id must not collide at index 0 — key them by id into a
  // synthetic index range instead (order among them follows arrival).
  const syntheticIndexById = new Map<string, number>();

  const readChunk = async () => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = reader.read();
      read.catch(() => {}); // the race can abandon this promise; don't let its rejection go unhandled
      return await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(`upstream stream stalled: no data for ${idleMs}ms (BELLA_STREAM_IDLE_TIMEOUT_MS)`)),
            idleMs,
          );
        }),
      ]);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  let sawFinish = false;
  reading: while (!sawFinish) {
    const { done, value } = await readChunk();
    if (done) break;
    if (value) {
      held.push(value);
      heldBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
    }
    let sep: RegExpMatchArray | null;
    while ((sep = buffer.match(/\r?\n\r?\n/))) {
      const event = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index! + sep[0].length);
      const payload = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!payload) continue;
      if (payload === "[DONE]") break reading;
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta;
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          let index: number;
          if (typeof tc?.index === "number") {
            index = tc.index;
          } else if (typeof tc?.id === "string" && tc.id) {
            if (!syntheticIndexById.has(tc.id)) syntheticIndexById.set(tc.id, 1_000_000 + syntheticIndexById.size);
            index = syntheticIndexById.get(tc.id)!;
          } else {
            index = 0;
          }
          const acc = calls.get(index) ?? { args: "" };
          if (typeof tc?.id === "string" && tc.id) acc.id = tc.id;
          if (typeof tc?.function?.name === "string" && tc.function.name) acc.name = tc.function.name;
          if (typeof tc?.function?.arguments === "string") acc.args += tc.function.arguments;
          calls.set(index, acc);
        }
      }
      if (!calls.size && typeof delta?.content === "string" && delta.content.length) {
        contentChars += delta.content.length;
        if (contentChars > holdChars) return { decision: "answer", held };
      }
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) sawFinish = true;
    }
    if (!sawFinish && heldBytes > DECISION_HELD_BYTES_CAP) return { decision: "answer", held };
  }

  if (!calls.size) return { decision: "answer", held };

  const toolCalls = Array.from(calls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id || newId(),
      type: "function",
      function: { name: call.name ?? "", arguments: call.args },
    }));
  if (toolCalls.some((call) => !isMemoryToolCall(call))) return { decision: "external_tool", held };
  return {
    decision: "memory_tool",
    held,
    assistantMessage: { role: "assistant", content: null, tool_calls: toolCalls },
    memoryCalls: toolCalls.map((call) => ({ id: call.id, queries: parseToolArgs(call.function.arguments) })),
  };
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

function topMemoryResults(results: MemoryResult[]): MemoryResult[] {
  const merged = new Map<string, MemoryResult>();
  for (const result of results) {
    const prev = merged.get(result.id);
    if (!prev || result.similarity > prev.similarity) merged.set(result.id, result);
  }
  return Array.from(merged.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Q.MAX_COMBINED_RESULTS);
}

// One memory tool round: run the model's searchMemory calls under a shared per-turn query budget and
// build the role:"tool" result messages. Shared by the buffered and streamed paths so degradation
// semantics (timeout → empty results, failure → empty results + memory_search_unavailable) stay identical.
type MemoryToolRound = {
  toolMessages: any[];
  allResults: MemoryResult[];
  usedQueries: string[];
  toolSearchTimedOut: boolean;
  toolSearchFailed: boolean;
  toolSearchError?: string;
};

async function runMemoryToolRound(
  ctx: Ctx,
  calls: { id: string; queries: string[] }[],
  opts: { userId?: string; containerTag?: string },
): Promise<MemoryToolRound> {
  let remainingQueries = MAX_QUERIES_PER_CALL;
  let toolSearchTimedOut = false;
  let toolSearchFailed = false;
  let toolSearchError: string | undefined;
  const toolMessages: any[] = [];
  const allResults: MemoryResult[] = [];
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
        // Recall failure must not kill a turn the model already answered with a tool call. The model's
        // response is intact and the timeout path two branches up already proves "continue with empty
        // results" is safe — reuse it, mark the degradation in the trace, and let the model answer
        // without memory instead of returning a 500 that discards its work.
        failed = true;
        toolSearchFailed = true;
        toolSearchError = e instanceof Error ? e.message : String(e);
        console.warn("[proxy] memory tool search failed; continuing with empty results:", toolSearchError);
        results = [];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    allResults.push(...results);
    toolMessages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(toolResultPayload(queries, results, failed ? "memory_search_unavailable" : undefined)),
    });
  }
  return { toolMessages, allResults, usedQueries, toolSearchTimedOut, toolSearchFailed, ...(toolSearchError ? { toolSearchError } : {}) };
}

function proxyResponse(
  body: string,
  status: number,
  contentType: string | null,
  trace: {
    traceId: string;
    contextModified: boolean;
    searchResults: number;
    latencyMs: number;
    toolIntercept?: string;
    memoryRound?: boolean;
    passthrough?: boolean;
  },
) {
  const headers = new Headers();
  headers.set("content-type", contentType || "application/json");
  headers.set("x-bella-trace-id", trace.traceId);
  headers.set("x-bella-conversation-id", trace.traceId);
  headers.set("x-bella-context-modified", String(trace.contextModified));
  headers.set("x-bella-search-results", String(trace.searchResults));
  headers.set("x-bella-search-latency-ms", String(Math.max(0, Math.round(trace.latencyMs))));
  headers.set("x-bella-memory-round", String(!!trace.memoryRound));
  if (trace.toolIntercept) headers.set("x-bella-tool-intercept", trace.toolIntercept);
  if (trace.passthrough) headers.set("x-bella-tool-passthrough", "true");
  return new Response(body, { status, headers });
}

function streamTraceHeaders(
  contentType: string | null,
  trace: {
    traceId: string;
    contextModified: boolean;
    searchResults: number;
    latencyMs: number;
    memoryRound?: boolean;
    toolIntercept?: string;
    passthrough?: boolean;
  },
) {
  const headers = new Headers();
  headers.set("content-type", contentType || "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("x-bella-trace-id", trace.traceId);
  headers.set("x-bella-conversation-id", trace.traceId);
  headers.set("x-bella-context-modified", String(trace.contextModified));
  headers.set("x-bella-search-results", String(trace.searchResults));
  headers.set("x-bella-search-latency-ms", String(Math.max(0, Math.round(trace.latencyMs))));
  headers.set("x-bella-memory-round", String(!!trace.memoryRound));
  headers.set("x-bella-streaming", "true");
  if (trace.toolIntercept) headers.set("x-bella-tool-intercept", trace.toolIntercept);
  if (trace.passthrough) headers.set("x-bella-tool-passthrough", "true");
  return headers;
}

// Low-level SSE piping: enqueue `prefix` chunks first (bytes readStreamDecision already consumed from
// upstream), then pump `reader` until it drains. A null reader means "replay prefix only".
function pipeStream(
  reader: ByteStreamReader | null,
  prefix: Uint8Array[],
  status: number,
  headers: Headers,
  onDone: (info: { chunkCount: number; byteCount: number; error?: string }) => Promise<void>,
) {
  const pending = [...prefix];
  let chunkCount = 0;
  let byteCount = 0;
  let finished = false;
  const finish = async (error?: string) => {
    if (finished) return;
    finished = true;
    await onDone({ chunkCount, byteCount, error });
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending.length) {
        const value = pending.shift()!;
        chunkCount += 1;
        byteCount += value.byteLength;
        controller.enqueue(value);
        return;
      }
      if (!reader) {
        await finish();
        controller.close();
        return;
      }
      // Idle timeout per READ, not per stream: the timer only runs while a read is outstanding, so a
      // slow CONSUMER (backpressure, no pull pending) never trips it — only an upstream that goes silent
      // mid-stream does. Without this, a stalled upstream held the response open forever.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const idleMs = streamIdleTimeoutMs();
        const read = reader.read();
        read.catch(() => {}); // the race can abandon this promise; don't let its rejection go unhandled
        const { done, value } = await Promise.race([
          read,
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(
              () => reject(new Error(`upstream stream stalled: no data for ${idleMs}ms (BELLA_STREAM_IDLE_TIMEOUT_MS)`)),
              idleMs,
            );
          }),
        ]);
        if (done) {
          await finish();
          controller.close();
          return;
        }
        if (value) {
          chunkCount += 1;
          byteCount += value.byteLength;
          controller.enqueue(value);
        }
      } catch (e) {
        try {
          await reader.cancel(e); // release the upstream connection on stall/error
        } catch {}
        const error = e instanceof Error ? e.message : String(e);
        await finish(error);
        controller.error(e);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    },
    async cancel(reason) {
      try {
        if (reader) await reader.cancel(reason);
      } finally {
        await finish(reason == null ? "cancelled" : `cancelled: ${String(reason)}`);
      }
    },
  });

  return new Response(body, { status, headers });
}

function proxyStreamResponse(
  upstreamRes: Response,
  trace: {
    traceId: string;
    contextModified: boolean;
    searchResults: number;
    latencyMs: number;
    passthrough?: boolean;
  },
  onDone: (info: { chunkCount: number; byteCount: number; error?: string }) => Promise<void>,
) {
  const headers = streamTraceHeaders(upstreamRes.headers.get("content-type"), trace);
  if (!upstreamRes.body) {
    void onDone({ chunkCount: 0, byteCount: 0 });
    return new Response(null, { status: upstreamRes.status, headers });
  }
  return pipeStream(upstreamRes.body.getReader(), [], upstreamRes.status, headers, onDone);
}

export function proxyRoutes(ctx: Ctx) {
  const app = new Hono();

  // POST /v1/chat/completions
  app.post("/chat/completions", async (c) => {
    const started = Date.now();
    const traceId = newId();
    const fetcher = ctx.fetch ?? fetch;
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "JSON request body is required" }, 400);
    if (!Array.isArray(body.messages)) return c.json({ error: "messages array is required" }, 400);

    const userId =
      c.req.header("x-bella-user-id") ||
      (typeof body.user === "string" ? body.user : undefined) ||
      new URL(c.req.url).searchParams.get("userId") ||
      undefined;
    const containerTag = c.req.header("x-bella-container-tag") || body.containerTag || DEFAULT_CONTAINER_TAG;
    delete body.containerTag; // Bellamente routing hint, not an upstream chat-completions parameter.
    const query = promptText(body);


    // 1. passthrough if request already carries tool_result content
    if (hasToolResults(body)) {
      const upstream = upstreamConfig(c, ctx);
      if (!upstream.ok) {
        const latencyMs = Date.now() - started;
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "proxy",
          status: "upstream_config_error",
          userId,
          containerTag,
          query,
          latencyMs,
          request: requestSummary(body),
          metadata: { error: upstream.error, upstreamBase: upstream.upstreamBase, hasToolResults: true },
        });
        return proxyResponse(JSON.stringify({ error: upstream.error, traceId }), upstream.status, "application/json", {
          traceId,
          contextModified: false,
          searchResults: 0,
          latencyMs,
          passthrough: true,
        });
      }
      const deadline = upstreamDeadline(upstreamTimeoutMs());
      let upstreamRes: Response | null = null;
      let upstreamBody: { text: string; json: any } | null = null;
      let upstreamError: string | null = null;
      try {
        upstreamRes = await forwardUpstream(fetcher, upstream, body, deadline.signal);
        if (body.stream === true && upstreamRes.ok) {
          deadline.clear(); // headers are in; the per-read idle timeout owns the stream from here
          const streamRes = upstreamRes;
          const initialLatencyMs = Date.now() - started;
          return proxyStreamResponse(
            streamRes,
            { traceId, contextModified: false, searchResults: 0, latencyMs: initialLatencyMs, passthrough: true },
            async ({ chunkCount, byteCount, error }) => {
              const latencyMs = Date.now() - started;
              await recordTraceSafe(ctx.sql, {
                id: traceId,
                kind: "proxy",
                status: error ? "stream_error" : "streamed_passthrough",
                userId,
                containerTag,
                query,
                latencyMs,
                request: requestSummary(body),
                metadata: {
                  hasToolResults: true,
                  streaming: true,
                  upstreamStatus: streamRes.status,
                  chunkCount,
                  byteCount,
                  ...(error ? { error } : {}),
                },
              });
            },
          );
        }
        upstreamBody = await readUpstreamBody(upstreamRes);
      } catch (e) {
        upstreamError = upstreamErrorMessage(e);
      } finally {
        deadline.clear();
      }
      if (upstreamError !== null || !upstreamRes || !upstreamBody) {
        const latencyMs = Date.now() - started;
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "proxy",
          status: "upstream_error",
          userId,
          containerTag,
          query,
          latencyMs,
          request: requestSummary(body),
          metadata: { hasToolResults: true, error: upstreamError ?? "upstream exchange failed" },
        });
        return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
          traceId,
          contextModified: false,
          searchResults: 0,
          latencyMs,
          passthrough: true,
        });
      }
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: upstreamRes.ok ? "passthrough" : "upstream_error",
        userId,
        containerTag,
        query,
        latencyMs,
        request: requestSummary(body),
        metadata: { hasToolResults: true, upstreamStatus: upstreamRes.status },
      });
      return proxyResponse(upstreamBody.text, upstreamRes.status, upstreamRes.headers.get("content-type"), {
        traceId,
        contextModified: false,
        searchResults: 0,
        latencyMs,
        passthrough: true,
      });
    }

    // 2. inject tool (buffered and streamed requests both run the memory tool round)
    const streaming = body.stream === true;
    const toolAlreadyPresent = injectMemoryTool(body);

    // 3. inject profile
    const profile = await loadProfile(ctx.sql, containerTag);
    const block = profileContextBlock(formatProfile(profile));
    injectProfileBlock(body, block);

    const contextInjected = [
      ...(!toolAlreadyPresent
        ? [traceTextItem("tool", MEMORY_TOOL_DESCRIPTION, { id: MEMORY_TOOL_NAME, name: MEMORY_TOOL_NAME })]
        : []),
      traceTextItem("profile", block.trim(), {
        staticCount: profile.static?.length ?? 0,
        dynamicCount: profile.dynamic?.length ?? 0,
      }),
    ];

    if (c.req.header("x-bella-proxy-mode") === "inject-only" || brandEnv("PROXY_INJECT_ONLY") === "1") {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "context_injected",
        userId,
        containerTag,
        query,
        latencyMs,
        injectedCount: contextInjected.length,
        injected: contextInjected,
        request: requestSummary(body),
        metadata: { toolAlreadyPresent, upstreamForwardWired: true, injectOnly: true },
      });
      return proxyResponse(
        JSON.stringify({ note: "inject-only mode: tool + profile injected; upstream not called", traceId }),
        200,
        "application/json",
        { traceId, contextModified: true, searchResults: 0, latencyMs, toolIntercept: MEMORY_TOOL_NAME },
      );
    }

    if (streaming) {
      const upstream = upstreamConfig(c, ctx);
      if (!upstream.ok) {
        const latencyMs = Date.now() - started;
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "proxy",
          status: "upstream_config_error",
          userId,
          containerTag,
          query,
          latencyMs,
          injectedCount: contextInjected.length,
          injected: contextInjected,
          request: requestSummary(body),
          metadata: { error: upstream.error, upstreamBase: upstream.upstreamBase, streaming: true, toolAlreadyPresent },
        });
        return proxyResponse(JSON.stringify({ error: upstream.error, traceId }), upstream.status, "application/json", {
          traceId,
          contextModified: true,
          searchResults: 0,
          latencyMs,
        });
      }

      const deadline = upstreamDeadline(upstreamTimeoutMs());
      let upstreamRes: Response | null = null;
      let errorBody: { text: string; json: any } | null = null;
      let upstreamError: string | null = null;
      try {
        upstreamRes = await forwardUpstream(fetcher, upstream, body, deadline.signal);
        if (!upstreamRes.ok) errorBody = await readUpstreamBody(upstreamRes);
        else deadline.clear(); // headers are in; the per-read idle timeout owns the stream from here
      } catch (e) {
        upstreamError = upstreamErrorMessage(e);
      } finally {
        deadline.clear();
      }

      if (upstreamError !== null || !upstreamRes) {
        const latencyMs = Date.now() - started;
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "proxy",
          status: "upstream_error",
          userId,
          containerTag,
          query,
          latencyMs,
          injectedCount: contextInjected.length,
          injected: contextInjected,
          request: requestSummary(body),
          metadata: { error: upstreamError ?? "upstream exchange failed", streaming: true, toolAlreadyPresent },
        });
        return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
          traceId,
          contextModified: true,
          searchResults: 0,
          latencyMs,
        });
      }

      const firstRes = upstreamRes;
      if (!firstRes.ok) {
        const latencyMs = Date.now() - started;
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "proxy",
          status: "upstream_error",
          userId,
          containerTag,
          query,
          latencyMs,
          injectedCount: contextInjected.length,
          injected: contextInjected,
          request: requestSummary(body),
          metadata: { upstreamStatus: firstRes.status, streaming: true, toolAlreadyPresent },
        });
        return proxyResponse(errorBody?.text ?? "", firstRes.status, firstRes.headers.get("content-type"), {
          traceId,
          contextModified: true,
          searchResults: 0,
          latencyMs,
        });
      }

      // Classify the stream before piping anything to the client: plain answer, external tool call,
      // or a searchMemory call that needs a second upstream round.
      const firstReader = firstRes.body ? firstRes.body.getReader() : null;
      let decision: StreamDecision = { decision: "answer", held: [] };
      if (firstReader) {
        try {
          decision = await readStreamDecision(firstReader, streamIdleTimeoutMs());
        } catch (e) {
          try {
            await firstReader.cancel(e); // release the upstream connection on stall/error
          } catch {}
          const error = e instanceof Error ? e.message : String(e);
          const latencyMs = Date.now() - started;
          await recordTraceSafe(ctx.sql, {
            id: traceId,
            kind: "proxy",
            status: "stream_error",
            userId,
            containerTag,
            query,
            latencyMs,
            injectedCount: contextInjected.length,
            injected: contextInjected,
            request: requestSummary(body),
            metadata: {
              streaming: true,
              memoryRound: false,
              upstreamStatus: firstRes.status,
              toolAlreadyPresent,
              contextInjectedCount: contextInjected.length,
              error,
            },
          });
          return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
            traceId,
            contextModified: true,
            searchResults: 0,
            latencyMs,
          });
        }
      }

      if (decision.decision !== "memory_tool") {
        // answer → replay what classification consumed, then pipe the rest live. external tool call →
        // same replay; the client owns that tool round (mirrors the buffered external passthrough).
        const externalTool = decision.decision === "external_tool";
        const initialLatencyMs = Date.now() - started;
        const headers = streamTraceHeaders(firstRes.headers.get("content-type"), {
          traceId,
          contextModified: true,
          searchResults: 0,
          latencyMs: initialLatencyMs,
          toolIntercept: MEMORY_TOOL_NAME, // the tool WAS injected — same signal the buffered path emits
        });
        return pipeStream(firstReader, decision.held, firstRes.status, headers, async ({ chunkCount, byteCount, error }) => {
          const latencyMs = Date.now() - started;
          await recordTraceSafe(ctx.sql, {
            id: traceId,
            kind: "proxy",
            status: error ? "stream_error" : externalTool ? "upstream_tool_calls" : "streamed",
            userId,
            containerTag,
            query,
            latencyMs,
            injectedCount: contextInjected.length,
            injected: contextInjected,
            request: requestSummary(body),
            metadata: {
              streaming: true,
              memoryRound: false,
              upstreamStatus: firstRes.status,
              toolAlreadyPresent,
              contextInjectedCount: contextInjected.length,
              chunkCount,
              byteCount,
              ...(error ? { error } : {}),
            },
          });
          // Auto-capture after a clean answer stream completes (fire-and-forget; see src/capture.ts).
          if (!error && !externalTool) {
            void captureFromTurn(ctx, { messages: body.messages, containerTag, userId, proxyTraceId: traceId });
          }
        });
      }

      // Memory tool round: the held tool-call chunks never reach the client — run the searches, ask
      // upstream again with the results appended, and stream ONLY the second response.
      try {
        await firstReader!.cancel(); // memory_tool implies a reader existed; drop the rest of stream one
      } catch {}
      const round = await runMemoryToolRound(ctx, decision.memoryCalls, { userId, containerTag });
      const finalResults = topMemoryResults(round.allResults);
      const traceItems = traceItemsFromSearchResults(finalResults);
      const finalRequest = {
        ...body,
        messages: [...body.messages, decision.assistantMessage, ...round.toolMessages],
        tool_choice: "none",
      };

      const secondDeadline = upstreamDeadline(upstreamTimeoutMs());
      let secondRes: Response | null = null;
      let secondErrorBody: { text: string; json: any } | null = null;
      let secondError: string | null = null;
      try {
        secondRes = await forwardUpstream(fetcher, upstream, finalRequest, secondDeadline.signal);
        if (!secondRes.ok) secondErrorBody = await readUpstreamBody(secondRes);
        else secondDeadline.clear(); // headers are in; the per-read idle timeout owns the stream from here
      } catch (e) {
        secondError = upstreamErrorMessage(e);
      } finally {
        secondDeadline.clear();
      }

      if (secondError !== null || !secondRes || !secondRes.ok) {
        const latencyMs = Date.now() - started;
        await recordTraceSafe(ctx.sql, {
          id: traceId,
          kind: "proxy",
          status: "upstream_error",
          userId,
          containerTag,
          query,
          queries: round.usedQueries,
          searchMode: "memories",
          resultCount: finalResults.length,
          injectedCount: finalResults.length,
          latencyMs,
          retrieved: traceItems,
          injected: traceItems,
          request: requestSummary(finalRequest),
          metadata: {
            streaming: true,
            memoryRound: true,
            toolAlreadyPresent,
            toolCallCount: round.toolMessages.length,
            firstUpstreamStatus: firstRes.status,
            contextInjectedCount: contextInjected.length,
            toolSearchTimedOut: round.toolSearchTimedOut,
            toolSearchFailed: round.toolSearchFailed,
            ...(round.toolSearchError ? { toolSearchError: round.toolSearchError } : {}),
            ...(secondRes ? { upstreamStatus: secondRes.status } : {}),
            ...(secondError ? { error: secondError } : {}),
          },
        });
        if (secondRes && !secondRes.ok) {
          return proxyResponse(secondErrorBody?.text ?? "", secondRes.status, secondRes.headers.get("content-type"), {
            traceId,
            contextModified: true,
            searchResults: finalResults.length,
            latencyMs,
            toolIntercept: MEMORY_TOOL_NAME,
            memoryRound: true,
          });
        }
        return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
          traceId,
          contextModified: true,
          searchResults: finalResults.length,
          latencyMs,
          toolIntercept: MEMORY_TOOL_NAME,
          memoryRound: true,
        });
      }

      const finalStreamRes = secondRes;
      const initialLatencyMs = Date.now() - started;
      const headers = streamTraceHeaders(finalStreamRes.headers.get("content-type"), {
        traceId,
        contextModified: true,
        searchResults: finalResults.length,
        latencyMs: initialLatencyMs,
        memoryRound: true,
        toolIntercept: MEMORY_TOOL_NAME,
      });
      return pipeStream(
        finalStreamRes.body ? finalStreamRes.body.getReader() : null,
        [],
        finalStreamRes.status,
        headers,
        async ({ chunkCount, byteCount, error }) => {
          const latencyMs = Date.now() - started;
          await recordTraceSafe(ctx.sql, {
            id: traceId,
            kind: "proxy",
            status: error ? "stream_error" : "streamed",
            userId,
            containerTag,
            query,
            queries: round.usedQueries,
            searchMode: "memories",
            resultCount: finalResults.length,
            injectedCount: finalResults.length,
            latencyMs,
            retrieved: traceItems,
            injected: traceItems,
            request: requestSummary(finalRequest),
            metadata: {
              streaming: true,
              memoryRound: true,
              toolAlreadyPresent,
              toolCallCount: round.toolMessages.length,
              upstreamStatus: finalStreamRes.status,
              firstUpstreamStatus: firstRes.status,
              contextInjectedCount: contextInjected.length,
              toolSearchTimedOut: round.toolSearchTimedOut,
              toolSearchFailed: round.toolSearchFailed,
              ...(round.toolSearchError ? { toolSearchError: round.toolSearchError } : {}),
              chunkCount,
              byteCount,
              ...(error ? { error } : {}),
            },
          });
          // Auto-capture after the memory-grounded answer stream completes cleanly (see src/capture.ts).
          if (!error) {
            void captureFromTurn(ctx, { messages: body.messages, containerTag, userId, proxyTraceId: traceId });
          }
        },
      );
    }

    const upstream = upstreamConfig(c, ctx);
    if (!upstream.ok) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "upstream_config_error",
        userId,
        containerTag,
        query,
        latencyMs,
        injectedCount: contextInjected.length,
        injected: contextInjected,
        request: requestSummary(body),
        metadata: { error: upstream.error, upstreamBase: upstream.upstreamBase, toolAlreadyPresent },
      });
      return proxyResponse(JSON.stringify({ error: upstream.error, traceId }), upstream.status, "application/json", {
        traceId,
        contextModified: true,
        searchResults: 0,
        latencyMs,
        toolIntercept: MEMORY_TOOL_NAME,
      });
    }

    const first = await bufferedUpstreamExchange(fetcher, upstream, body);
    if (!first.ok) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "upstream_error",
        userId,
        containerTag,
        query,
        latencyMs,
        injectedCount: contextInjected.length,
        injected: contextInjected,
        request: requestSummary(body),
        metadata: { error: first.error, toolAlreadyPresent },
      });
      return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
        traceId,
        contextModified: true,
        searchResults: 0,
        latencyMs,
        toolIntercept: MEMORY_TOOL_NAME,
      });
    }
    const firstRes = first.res;
    const firstBody = { text: first.text, json: first.json };
    if (!firstRes.ok) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "upstream_error",
        userId,
        containerTag,
        query,
        latencyMs,
        injectedCount: contextInjected.length,
        injected: contextInjected,
        request: requestSummary(body),
        metadata: { upstreamStatus: firstRes.status, toolAlreadyPresent },
      });
      return proxyResponse(firstBody.text, firstRes.status, firstRes.headers.get("content-type"), {
        traceId,
        contextModified: true,
        searchResults: 0,
        latencyMs,
        toolIntercept: MEMORY_TOOL_NAME,
      });
    }

    const toolCalls = firstMemoryToolCalls(firstBody.json);
    const externalCalls = externalToolCalls(firstBody.json);
    if (externalCalls.length) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "upstream_tool_calls",
        userId,
        containerTag,
        query,
        latencyMs,
        request: requestSummary(body),
        metadata: {
          memoryRound: false,
          upstreamStatus: firstRes.status,
          toolAlreadyPresent,
          contextInjectedCount: contextInjected.length,
          memoryToolCallCount: toolCalls.length,
          externalToolCallCount: externalCalls.length,
        },
      });
      return proxyResponse(firstBody.text, firstRes.status, firstRes.headers.get("content-type"), {
        traceId,
        contextModified: true,
        searchResults: 0,
        latencyMs,
        toolIntercept: MEMORY_TOOL_NAME,
      });
    }

    if (!toolCalls.length) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "answered",
        userId,
        containerTag,
        query,
        latencyMs,
        request: requestSummary(body),
        metadata: { memoryRound: false, upstreamStatus: firstRes.status, toolAlreadyPresent, contextInjectedCount: contextInjected.length },
      });
      // Auto-capture (fire-and-forget; never delays or breaks the turn — see src/capture.ts).
      void captureFromTurn(ctx, { messages: body.messages, containerTag, userId, proxyTraceId: traceId });
      return proxyResponse(firstBody.text, firstRes.status, firstRes.headers.get("content-type"), {
        traceId,
        contextModified: true,
        searchResults: 0,
        latencyMs,
        toolIntercept: MEMORY_TOOL_NAME,
      });
    }

    const round = await runMemoryToolRound(ctx, toolCalls, { userId, containerTag });
    const { toolMessages, usedQueries, toolSearchTimedOut, toolSearchFailed, toolSearchError } = round;
    const finalResults = topMemoryResults(round.allResults);
    const traceItems = traceItemsFromSearchResults(finalResults);

    const finalRequest = {
      ...body,
      messages: [...body.messages, toolCalls[0]!.assistantMessage, ...toolMessages],
      tool_choice: "none",
    };

    const final = await bufferedUpstreamExchange(fetcher, upstream, finalRequest);
    if (!final.ok) {
      const latencyMs = Date.now() - started;
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "upstream_error",
        userId,
        containerTag,
        query,
        queries: usedQueries,
        searchMode: "memories",
        resultCount: finalResults.length,
        injectedCount: finalResults.length,
        latencyMs,
        retrieved: traceItems,
        injected: traceItems,
        request: requestSummary(finalRequest),
        metadata: {
          memoryRound: true,
          toolAlreadyPresent,
          toolCallCount: toolMessages.length,
          firstUpstreamStatus: firstRes.status,
          contextInjectedCount: contextInjected.length,
          toolSearchTimedOut,
          toolSearchFailed,
          ...(toolSearchError ? { toolSearchError } : {}),
          error: final.error,
        },
      });
      return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
        traceId,
        contextModified: true,
        searchResults: finalResults.length,
        latencyMs,
        toolIntercept: MEMORY_TOOL_NAME,
        memoryRound: true,
      });
    }
    const finalRes = final.res;
    const finalBody = { text: final.text, json: final.json };
    const latencyMs = Date.now() - started;
    await recordTraceSafe(ctx.sql, {
      id: traceId,
      kind: "proxy",
      status: finalRes.ok ? "answered" : "upstream_error",
      userId,
      containerTag,
      query,
      queries: usedQueries,
      searchMode: "memories",
      resultCount: finalResults.length,
      injectedCount: finalResults.length,
      latencyMs,
      retrieved: traceItems,
      injected: traceItems,
      request: requestSummary(finalRequest),
      metadata: {
        memoryRound: true,
        toolAlreadyPresent,
        toolCallCount: toolMessages.length,
        upstreamStatus: finalRes.status,
        firstUpstreamStatus: firstRes.status,
        contextInjectedCount: contextInjected.length,
        toolSearchTimedOut,
        toolSearchFailed,
        ...(toolSearchError ? { toolSearchError } : {}),
      },
    });

    // Auto-capture (fire-and-forget; only on a successful answer).
    if (finalRes.ok) {
      void captureFromTurn(ctx, { messages: body.messages, containerTag, userId, proxyTraceId: traceId });
    }

    return proxyResponse(finalBody.text, finalRes.status, finalRes.headers.get("content-type"), {
      traceId,
      contextModified: true,
      searchResults: finalResults.length,
      latencyMs,
      toolIntercept: MEMORY_TOOL_NAME,
      memoryRound: true,
    });
  });

  return app;
}
