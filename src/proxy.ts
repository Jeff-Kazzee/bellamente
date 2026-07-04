// proxy.ts - Chat Completions-compatible interceptor. Injects a memory-search tool + user context.
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { formatProfile, profileContextBlock, loadProfile } from "./profile";
import { DEFAULT_CONTAINER_TAG, newId } from "./util";
import { brandEnv } from "./env";
import { captureFromTurn } from "./capture";
import { recordTraceSafe, traceItemsFromSearchResults, traceTextItem } from "./inspect";
import { handleStreamingProxy, proxyStreamResponse } from "./proxy-stream";
import { hasToolResults, promptText, requestSummary } from "./proxy-request";
import { proxyResponse } from "./proxy-response";
import { isNamedToolCall, MAX_QUERIES_PER_CALL, memoryToolCallFromChatCall, MIN_QUERIES_PER_CALL } from "./proxy-tool";
import { runMemoryToolRound, topMemoryResults } from "./proxy-tool-round";
import {
  resolveUpstream,
  upstreamDeadline,
  upstreamTimeoutMs,
  streamIdleTimeoutMs,
  forwardUpstream,
  readUpstreamBody,
  upstreamErrorMessage,
  type FetchLike,
  type UpstreamCtx,
  type UpstreamConfig,
} from "./upstream";

export { upstreamTimeoutMs, streamIdleTimeoutMs };
export { streamDecisionHoldChars } from "./proxy-stream";
export { runToolSearch } from "./proxy-tool-round";

type Ctx = { sql: DB; embed: Embed } & UpstreamCtx;

export const MEMORY_TOOL_NAME = "searchMemory";

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

// Per-request header overrides layered onto the shared resolver (src/upstream.ts).
function upstreamConfig(c: any, ctx: Ctx): UpstreamConfig {
  return resolveUpstream(ctx, {
    authorization: c.req.header("x-bella-upstream-authorization"),
    apiKey: c.req.header("x-bella-upstream-api-key"),
  });
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


function firstToolCallMessage(upstreamJson: any): any | null {
  const message = upstreamJson?.choices?.[0]?.message;
  return message && Array.isArray(message.tool_calls) ? message : null;
}

function isMemoryToolCall(call: any): boolean {
  return isNamedToolCall(call, MEMORY_TOOL_NAME);
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
    calls.push({ ...memoryToolCallFromChatCall(call), assistantMessage: message });
  }
  return calls;
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
      return handleStreamingProxy({
        ctx,
        fetcher,
        upstream: upstreamConfig(c, ctx),
        body,
        started,
        traceId,
        userId,
        containerTag,
        query,
        contextInjected,
        toolAlreadyPresent,
        memoryToolName: MEMORY_TOOL_NAME,
      });
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
      void captureFromTurn(ctx, {
              messages: body.messages,
              containerTag,
              userId,
              proxyTraceId: traceId,
              model: typeof body.model === "string" ? body.model : undefined,
            });
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
    const finalResults = topMemoryResults(round.allBatches);
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
      void captureFromTurn(ctx, {
              messages: body.messages,
              containerTag,
              userId,
              proxyTraceId: traceId,
              model: typeof body.model === "string" ? body.model : undefined,
            });
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
