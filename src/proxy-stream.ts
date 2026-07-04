// proxy-stream.ts - streaming Chat Completions helper functions for the proxy.
import type { DB } from "./db";
import type { Embed } from "./embed";
import { brandEnv } from "./env";
import { captureFromTurn } from "./capture";
import { recordTraceSafe, traceItemsFromSearchResults, type TraceItem } from "./inspect";
import { proxyResponse, streamTraceHeaders } from "./proxy-response";
import { requestSummary } from "./proxy-request";
import { isNamedToolCall, parseToolArgs } from "./proxy-tool";
import { runMemoryToolRound, topMemoryResults } from "./proxy-tool-round";
import {
  forwardUpstream,
  readUpstreamBody,
  streamIdleTimeoutMs,
  upstreamDeadline,
  upstreamErrorMessage,
  upstreamTimeoutMs,
  type FetchLike,
  type UpstreamConfig,
  type UpstreamCtx,
} from "./upstream";
import { newId } from "./util";

export type StreamDecision =
  | { decision: "answer"; held: Uint8Array[] }
  | { decision: "external_tool"; held: Uint8Array[] }
  | { decision: "memory_tool"; held: Uint8Array[]; assistantMessage: any; memoryCalls: { id: string; queries: string[] }[] };

// Structural reader type: Bun's getReader() returns a reader with extras (readMany) that the DOM
// ReadableStreamDefaultReader<Uint8Array> type doesn't unify with under tsc.
export type ByteStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown> | void;
};

// Local models often emit PREAMBLE content ("Let me check...") before their searchMemory call in the
// same choice. Committing to "answer" on the first content token would leak that tool call to a
// client that cannot serve it and silently skip memory grounding (the buffered path intercepts it
// regardless of content). So content is HELD until finish_reason/[DONE] - or until this many chars
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
// replayed - degraded, but bounded.
const DECISION_HELD_BYTES_CAP = 1_048_576;

// Streamed equivalent of firstMemoryToolCalls/externalToolCalls: read the upstream SSE stream just far
// enough to classify the turn. `function.arguments` arrives as string FRAGMENTS spread across delta
// chunks (often split mid-JSON), so fragments accumulate per tool-call index and only the concatenated
// whole is parsed. Every raw chunk read here is kept in `held` so answer/external decisions can replay
// the bytes to the client unmodified.
export async function readStreamDecision(reader: ByteStreamReader, idleMs: number, memoryToolName: string): Promise<StreamDecision> {
  const held: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let heldBytes = 0;
  let contentChars = 0;
  const holdChars = streamDecisionHoldChars();
  const calls = new Map<number, { id?: string; name?: string; args: string }>();
  // Deltas that omit `index` but carry an id must not collide at index 0 - key them by id into a
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
  if (toolCalls.some((call) => !isNamedToolCall(call, memoryToolName))) return { decision: "external_tool", held };
  return {
    decision: "memory_tool",
    held,
    assistantMessage: { role: "assistant", content: null, tool_calls: toolCalls },
    memoryCalls: toolCalls.map((call) => ({ id: call.id, queries: parseToolArgs(call.function.arguments) })),
  };
}

// Low-level SSE piping: enqueue `prefix` chunks first (bytes readStreamDecision already consumed from
// upstream), then pump `reader` until it drains. A null reader means "replay prefix only".
export function pipeStream(
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
      // slow CONSUMER (backpressure, no pull pending) never trips it - only an upstream that goes silent
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

export function proxyStreamResponse(
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
type StreamingCtx = { sql: DB; embed: Embed } & UpstreamCtx;


type StreamingProxyOptions = {
  ctx: StreamingCtx;
  fetcher: FetchLike;
  upstream: UpstreamConfig;
  body: any;
  started: number;
  traceId: string;
  userId?: string;
  containerTag: string;
  query?: string;
  contextInjected: TraceItem[];
  toolAlreadyPresent: boolean;
  memoryToolName: string;
};

export async function handleStreamingProxy({
  ctx,
  fetcher,
  upstream,
  body,
  started,
  traceId,
  userId,
  containerTag,
  query,
  contextInjected,
  toolAlreadyPresent,
  memoryToolName,
}: StreamingProxyOptions): Promise<Response> {
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
      decision = await readStreamDecision(firstReader, streamIdleTimeoutMs(), memoryToolName);
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
    // answer -> replay what classification consumed, then pipe the rest live. external tool call ->
    // same replay; the client owns that tool round (mirrors the buffered external passthrough).
    const externalTool = decision.decision === "external_tool";
    const initialLatencyMs = Date.now() - started;
    const headers = streamTraceHeaders(firstRes.headers.get("content-type"), {
      traceId,
      contextModified: true,
      searchResults: 0,
      latencyMs: initialLatencyMs,
      toolIntercept: memoryToolName, // the tool WAS injected - same signal the buffered path emits
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
        void captureFromTurn(ctx, {
          messages: body.messages,
          containerTag,
          userId,
          proxyTraceId: traceId,
          model: typeof body.model === "string" ? body.model : undefined,
        });
      }
    });
  }

  // Memory tool round: the held tool-call chunks never reach the client - run the searches, ask
  // upstream again with the results appended, and stream ONLY the second response.
  try {
    await firstReader!.cancel(); // memory_tool implies a reader existed; drop the rest of stream one
  } catch {}
  const round = await runMemoryToolRound(ctx, decision.memoryCalls, { userId, containerTag });
  const finalResults = topMemoryResults(round.allBatches);
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
        toolIntercept: memoryToolName,
        memoryRound: true,
      });
    }
    return proxyResponse(JSON.stringify({ error: "Upstream request failed", traceId }), 502, "application/json", {
      traceId,
      contextModified: true,
      searchResults: finalResults.length,
      latencyMs,
      toolIntercept: memoryToolName,
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
    toolIntercept: memoryToolName,
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
        void captureFromTurn(ctx, {
          messages: body.messages,
          containerTag,
          userId,
          proxyTraceId: traceId,
          model: typeof body.model === "string" ? body.model : undefined,
        });
      }
    },
  );
}
