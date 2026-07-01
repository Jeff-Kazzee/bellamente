// proxy.ts - OpenAI-compatible interceptor. Injects a memory-search tool + user context.
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { searchMemories, Q, type MemoryResult } from "./search";
import { formatProfile, profileContextBlock, loadProfile } from "./profile";
import { DEFAULT_CONTAINER_TAG, newId } from "./util";
import { recordTraceSafe, traceItemsFromSearchResults, traceTextItem } from "./inspect";

type Ctx = { sql: DB; embed: Embed };

export const MEMORY_TOOL_NAME = "searchMemory";
export const MIN_QUERIES_PER_CALL = 1;
export const MAX_QUERIES_PER_CALL = 5;

type ToolSearchTraceOpts = {
  traceId?: string;
  userId?: string;
  containerTag?: string;
  recordTrace?: boolean;
};

// One call per turn; batch all needed memory lookups into the queries array.
export function toolDescription() {
  return {
    name: MEMORY_TOOL_NAME,
    description:
      "Look up the user's saved memories and documents whenever you need context you do not already have - their preferences, facts about them, earlier conversations, or material they have stored. Call this at most once per turn: put every question you want answered into the `queries` array in a single call instead of invoking the tool repeatedly.",
    parameters: {
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
    },
  };
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

function promptText(body: any): string | undefined {
  const parts: string[] = [];
  if (typeof body.system === "string") parts.push("system: " + body.system);
  else if (body.system && typeof body.system === "object" && "content" in body.system) {
    parts.push("system: " + contentText((body.system as any).content));
  }
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
    hasSystem: body.system != null,
  };
}

export function proxyRoutes(ctx: Ctx) {
  const app = new Hono();

  // POST /v1/chat/completions
  app.post("/chat/completions", async (c) => {
    const started = Date.now();
    const traceId = newId();
    const body = await c.req.json().catch(() => ({}));
    const userId =
      c.req.header("x-eunoia-user-id") ||
      (typeof body.user === "string" ? body.user : undefined) ||
      new URL(c.req.url).searchParams.get("userId") ||
      undefined;
    const query = promptText(body);

    // 1. passthrough if request already carries tool_result content
    const hasToolResults = (body.messages ?? []).some(
      (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_result"),
    );
    if (hasToolResults) {
      const latencyMs = Date.now() - started;
      c.header("x-eunoia-tool-passthrough", "true");
      c.header("x-eunoia-context-modified", "false");
      c.header("x-eunoia-search-results", "0");
      c.header("x-eunoia-trace-id", traceId);
      c.header("x-eunoia-conversation-id", traceId);
      await recordTraceSafe(ctx.sql, {
        id: traceId,
        kind: "proxy",
        status: "passthrough",
        userId,
        containerTag: DEFAULT_CONTAINER_TAG,
        query,
        latencyMs,
        request: requestSummary(body),
        metadata: { hasToolResults: true },
      });
      return c.json({ note: "passthrough mode (upstream forward not wired - M3)", traceId });
    }

    // 2. inject tool
    body.tools = body.tools ?? [];
    const toolAlreadyPresent = body.tools.some((t: any) => t.name === MEMORY_TOOL_NAME);
    if (!toolAlreadyPresent) {
      body.tools.unshift(toolDescription());
    }

    // 3. inject profile
    const profile = await loadProfile(ctx.sql, DEFAULT_CONTAINER_TAG);
    const block = profileContextBlock(formatProfile(profile));
    if (typeof body.system === "string") body.system += block;
    else if (body.system && typeof body.system === "object" && "content" in body.system)
      body.system.content += block;
    else body.system = block.trim();

    const injected = [
      ...(toolAlreadyPresent
        ? []
        : [traceTextItem("tool", toolDescription().description, { id: MEMORY_TOOL_NAME, name: MEMORY_TOOL_NAME })]),
      traceTextItem("profile", block.trim(), {
        staticCount: profile.static?.length ?? 0,
        dynamicCount: profile.dynamic?.length ?? 0,
      }),
    ];

    // 4-7. forward upstream, intercept tool_calls, runToolSearch, re-invoke. TODO (M3).
    const latencyMs = Date.now() - started;
    c.header("x-eunoia-tool-intercept", MEMORY_TOOL_NAME);
    c.header("x-eunoia-context-modified", "true");
    c.header("x-eunoia-search-results", "0");
    c.header("x-eunoia-trace-id", traceId);
    c.header("x-eunoia-conversation-id", traceId);
    await recordTraceSafe(ctx.sql, {
      id: traceId,
      kind: "proxy",
      status: "context_injected",
      userId,
      containerTag: DEFAULT_CONTAINER_TAG,
      query,
      latencyMs,
      injectedCount: injected.length,
      injected,
      request: requestSummary(body),
      metadata: { toolAlreadyPresent, upstreamForwardWired: false },
    });
    return c.json({ note: "proxy core not wired (M3): tool + profile injected; upstream forward TODO", traceId });
  });

  return app;
}
