import { test, expect } from "bun:test";
import { encoder, makeCtx, memId, proxyInspectApp, readTrace, spaceId, sseResponse, TEST_TIMEOUT_MS } from "./proxy-fixture";

test("proxy streams upstream responses with profile context and trace visibility", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    expect(requestBody.stream).toBe(true);
    expect(requestBody.tools.map((tool: any) => tool.function?.name)).toEqual(["searchMemory"]);
    expect(requestBody.messages[0]).toMatchObject({ role: "system" });
    expect(requestBody.messages[0].content).toContain("John prefers concise answers");
    return sseResponse([
      'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"role":"assistant","content":"Use "},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-stream","choices":[{"index":0,"delta":{"content":"dark mode."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    await ctx.sql`
      UPDATE space SET metadata = ${ctx.sql.json({ profile: { static: ["John prefers concise answers"], dynamic: [] } })}
      WHERE id = ${spaceId}`;

    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bella-user-id": "external-user-stream" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-bella-streaming")).toBe("true");
    expect(res.headers.get("x-bella-context-modified")).toBe("true");
    expect(res.headers.get("x-bella-memory-round")).toBe("false");
    expect(res.headers.get("x-bella-tool-intercept")).toBe("searchMemory"); // tool injected - same signal as buffered
    const streamText = await res.text();
    expect(streamText).toContain("dark mode");
    expect(streamText).toContain("data: [DONE]");

    const traceId = res.headers.get("x-bella-trace-id");
    const trace = await readTrace(app, traceId);
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed", userId: "external-user-stream", resultCount: 0, injectedCount: 2 });
    expect(trace.injected[0]).toMatchObject({ type: "tool" });
    expect(trace.injected[1]).toMatchObject({ type: "profile" });
    expect(trace.metadata).toMatchObject({ streaming: true, memoryRound: false, upstreamStatus: 200, contextInjectedCount: 2, toolAlreadyPresent: false });
    expect(trace.metadata.chunkCount).toBe(3);
    expect(trace.metadata.byteCount).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy runs a streamed memory tool round and streams only the final answer", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    expect(requestBody.stream).toBe(true);
    if (upstreamCalls.length === 1) {
      expect(requestBody.tools.map((tool: any) => tool.function?.name)).toEqual(["searchMemory"]);
      // function.arguments arrives as string fragments split mid-JSON across chunk boundaries.
      return sseResponse([
        'data: {"id":"chatcmpl-tool","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_mem_1","type":"function","function":{"name":"searchMemory","arguments":"{\\"quer"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ies\\":[\\"which theme\\"]}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    expect(requestBody.tool_choice).toBe("none");
    const assistant = requestBody.messages.at(-2);
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0]).toMatchObject({
      id: "call_mem_1",
      type: "function",
      function: { name: "searchMemory", arguments: '{"queries":["which theme"]}' },
    });
    const toolMessage = requestBody.messages.at(-1);
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.tool_call_id).toBe("call_mem_1");
    expect(JSON.parse(toolMessage.content).results[0].content).toBe("John prefers dark mode");
    return sseResponse([
      'data: {"id":"chatcmpl-answer","choices":[{"index":0,"delta":{"role":"assistant","content":"Use dark mode."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bella-user-id": "external-user-stream-round" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-bella-streaming")).toBe("true");
    expect(res.headers.get("x-bella-memory-round")).toBe("true");
    expect(res.headers.get("x-bella-search-results")).toBe("1");
    expect(res.headers.get("x-bella-tool-intercept")).toBe("searchMemory");
    const streamText = await res.text();
    expect(streamText).toContain("Use dark mode.");
    expect(streamText).toContain("data: [DONE]");
    expect(streamText).not.toContain("call_mem_1");
    expect(streamText).not.toContain("tool_calls");

    const traceId = res.headers.get("x-bella-trace-id");
    const trace = await readTrace(app, traceId);
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed", userId: "external-user-stream-round", resultCount: 1, injectedCount: 1 });
    expect(trace.queries).toEqual(["which theme"]);
    expect(trace.retrieved[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.metadata).toMatchObject({
      streaming: true,
      memoryRound: true,
      toolCallCount: 1,
      upstreamStatus: 200,
      firstUpstreamStatus: 200,
      toolSearchTimedOut: false,
      toolSearchFailed: false,
    });
    expect(trace.metadata.chunkCount).toBe(2);
    expect(trace.metadata.byteCount).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy passes streamed external tool calls through verbatim", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    expect(requestBody.tools.map((tool: any) => tool.function?.name)).toEqual(["searchMemory", "lookupWeather"]);
    return sseResponse([
      'data: {"id":"chatcmpl-ext","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_weather_1","type":"function","function":{"name":"lookupWeather","arguments":"{\\"city\\":\\"Denver\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-ext","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "What is the weather in Denver?" }],
        tools: [{ type: "function", function: { name: "lookupWeather", description: "Weather lookup", parameters: { type: "object" } } }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(res.headers.get("x-bella-streaming")).toBe("true");
    expect(res.headers.get("x-bella-memory-round")).toBe("false");
    const streamText = await res.text();
    expect(streamText).toContain("call_weather_1");
    expect(streamText).toContain("lookupWeather");
    expect(streamText).toContain("data: [DONE]");

    const traceId = res.headers.get("x-bella-trace-id");
    const trace = await readTrace(app, traceId);
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_tool_calls", resultCount: 0 });
    expect(trace.metadata).toMatchObject({ streaming: true, memoryRound: false, upstreamStatus: 200 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy streamed memory round degrades to an answer when search fails", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    if (upstreamCalls.length === 1) {
      return sseResponse([
        'data: {"id":"chatcmpl-tool","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_mem_2","type":"function","function":{"name":"searchMemory","arguments":"{\\"queries\\":[\\"which theme\\"]}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    const toolMessage = requestBody.messages.at(-1);
    const payload = JSON.parse(toolMessage.content);
    expect(payload.error).toBe("memory_search_unavailable");
    expect(payload.results).toEqual([]);
    return sseResponse([
      'data: {"id":"chatcmpl-answer","choices":[{"index":0,"delta":{"role":"assistant","content":"Pick whichever theme you like."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const ctx = await makeCtx({
    fetch: fetcher,
    upstreamBaseUrl: "https://upstream.example/v1",
    allowUnauthenticatedUpstream: true,
    embed: async () => {
      throw new Error("embedder offline");
    },
  });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-bella-memory-round")).toBe("true");
    expect(res.headers.get("x-bella-search-results")).toBe("0");
    const streamText = await res.text();
    expect(streamText).toContain("Pick whichever theme you like.");

    const traceId = res.headers.get("x-bella-trace-id");
    const trace = await readTrace(app, traceId);
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed", resultCount: 0 });
    expect(trace.metadata).toMatchObject({ streaming: true, memoryRound: true, toolSearchFailed: true });
    expect(trace.metadata.toolSearchError).toContain("embedder offline");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy streams passthrough requests that already contain tool results", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    expect(requestBody.stream).toBe(true);
    expect(requestBody.messages).toHaveLength(2);
    expect(requestBody.messages[0].role).toBe("user");
    expect(requestBody.tools).toBeUndefined();
    return sseResponse(["data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Already handled.\"},\"finish_reason\":\"stop\"}]}\n\n", "data: [DONE]\n\n"]);
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [
          { role: "user", content: "Use the existing tool result" },
          { role: "tool", tool_call_id: "call_existing", content: "{}" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-bella-streaming")).toBe("true");
    expect(res.headers.get("x-bella-tool-passthrough")).toBe("true");
    expect(res.headers.get("x-bella-context-modified")).toBe("false");
    const streamText = await res.text();
    expect(streamText).toContain("Already handled");

    const traceId = res.headers.get("x-bella-trace-id");
    const trace = await readTrace(app, traceId);
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed_passthrough", resultCount: 0, injectedCount: 0 });
    expect(trace.metadata).toMatchObject({ hasToolResults: true, streaming: true, upstreamStatus: 200 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy errors a stalled stream after BELLA_STREAM_IDLE_TIMEOUT_MS", async () => {
  process.env.BELLA_STREAM_IDLE_TIMEOUT_MS = "50";
  // Content must exceed the decision hold window so the proxy commits to "answer" and starts piping
  // BEFORE the stall - pinning the mid-stream (post-headers) failure path.
  const longContent = "p".repeat(600);
  const fetcher: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"index":0,"delta":{"content":"${longContent}"}}]}\n\n`));
          // ...then go silent forever: never enqueue again, never close.
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(200); // headers arrived before the stall
    let streamFailed = false;
    try {
      await res.text();
    } catch {
      streamFailed = true;
    }
    expect(streamFailed).toBe(true);

    const traceId = res.headers.get("x-bella-trace-id");
    const trace = await readTrace(app, traceId);
    expect(trace).toMatchObject({ kind: "proxy", status: "stream_error" });
    expect(String(trace.metadata.error)).toContain("stalled");
  } finally {
    delete process.env.BELLA_STREAM_IDLE_TIMEOUT_MS;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streaming proxy returns 502 when a non-local upstream has no API key", async () => {
  const ctx = await makeCtx({ upstreamBaseUrl: "https://upstream.example/v1" }); // no key, no allow flag
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Missing upstream API key");

    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_config_error" });
    expect(trace.metadata).toMatchObject({ streaming: true });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streaming proxy returns 502 when the upstream fetch itself fails", async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error("connection refused (test)");
  };
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(502);
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error" });
    expect(trace.metadata).toMatchObject({ streaming: true });
    expect(String(trace.metadata.error)).toContain("connection refused");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streaming proxy forwards a non-OK upstream status and error body", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: "model not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "missing", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("model not found");
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error" });
    expect(trace.metadata).toMatchObject({ streaming: true, upstreamStatus: 404 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streaming proxy returns 502 stream_error when upstream stalls before any event", async () => {
  process.env.BELLA_STREAM_IDLE_TIMEOUT_MS = "50";
  const fetcher: typeof fetch = async () =>
    new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    // The stall happens while classifying the stream, BEFORE anything went to the client,
    // so the proxy can still answer with a proper error status instead of a broken stream.
    expect(res.status).toBe(502);
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "stream_error" });
    expect(String(trace.metadata.error)).toContain("stalled");
  } finally {
    delete process.env.BELLA_STREAM_IDLE_TIMEOUT_MS;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streamed memory round returns 502 when the second upstream call fails", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamCalls.push(JSON.parse(String(init?.body ?? "{}")));
    if (upstreamCalls.length === 1) {
      return sseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_mem_3","type":"function","function":{"name":"searchMemory","arguments":"{\\"queries\\":[\\"which theme\\"]}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    throw new Error("second call exploded (test)");
  };
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(502);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-bella-memory-round")).toBe("true");
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error", resultCount: 1 });
    expect(trace.metadata).toMatchObject({ streaming: true, memoryRound: true, firstUpstreamStatus: 200 });
    expect(String(trace.metadata.error)).toContain("second call exploded");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streamed memory round forwards a non-OK second upstream response", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamCalls.push(JSON.parse(String(init?.body ?? "{}")));
    if (upstreamCalls.length === 1) {
      return sseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_mem_4","type":"function","function":{"name":"searchMemory","arguments":"{\\"queries\\":[\\"which theme\\"]}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  };
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("overloaded");
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error" });
    expect(trace.metadata).toMatchObject({ streaming: true, memoryRound: true, upstreamStatus: 503, firstUpstreamStatus: 200 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streamed response with only [DONE] is replayed to the client as-is", async () => {
  const fetcher: typeof fetch = async () => sseResponse(["data: [DONE]\n\n"]);
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: [DONE]\n\n");
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed" });
    expect(trace.metadata).toMatchObject({ memoryRound: false, chunkCount: 1 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streamed memory round runs even when the model emits preamble content before the tool call", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamCalls.push(JSON.parse(String(init?.body ?? "{}")));
    if (upstreamCalls.length === 1) {
      // Local models often narrate before calling the tool. The preamble must be HELD, not piped -
      // otherwise the searchMemory call leaks to a client that cannot serve it.
      return sseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Let me check what I know..."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_mem_pre","type":"function","function":{"name":"searchMemory","arguments":"{\\"queries\\":[\\"which theme\\"]}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
    return sseResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Use dark mode."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-bella-memory-round")).toBe("true");
    const streamText = await res.text();
    expect(streamText).toContain("Use dark mode.");
    expect(streamText).not.toContain("Let me check"); // the preamble + tool call never reach the client
    expect(streamText).not.toContain("call_mem_pre");

    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed", resultCount: 1 });
    expect(trace.metadata).toMatchObject({ memoryRound: true });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("streamed tool-call deltas without index but with distinct ids do not collide", async () => {
  // Non-conformant upstreams may omit `index`; fragments must accumulate per id, not merge at 0.
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamCalls.push(JSON.parse(String(init?.body ?? "{}")));
    return sseResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_a","type":"function","function":{"name":"lookupWeather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_b","type":"function","function":{"name":"lookupNews","arguments":"{\\"topic\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_a","function":{"arguments":"\\"Denver\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_b","function":{"arguments":"\\"ai\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "Weather and news please" }],
        tools: [
          { type: "function", function: { name: "lookupWeather", parameters: { type: "object" } } },
          { type: "function", function: { name: "lookupNews", parameters: { type: "object" } } },
        ],
      }),
    });

    // Both calls are external -> verbatim passthrough with every chunk intact.
    expect(res.status).toBe(200);
    const streamText = await res.text();
    expect(streamText).toContain("call_a");
    expect(streamText).toContain("call_b");

    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_tool_calls" });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("SSE keepalive comment lines are tolerated during stream classification", async () => {
  const fetcher: typeof fetch = async () =>
    sseResponse([
      ": ping\n\n",
      ": ping\n\n",
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Answer after keepalives."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(200);
    const streamText = await res.text();
    expect(streamText).toContain("Answer after keepalives.");
    expect(streamText).toContain(": ping"); // replayed verbatim - the proxy does not rewrite bytes

    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed" });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("BELLA_STREAM_DECISION_HOLD_CHARS=0 restores commit-on-first-content", async () => {
  process.env.BELLA_STREAM_DECISION_HOLD_CHARS = "0";
  const fetcher: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" there."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = proxyInspectApp(ctx);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hi");
    const trace = await readTrace(app, res.headers.get("x-bella-trace-id"));
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed" });
    expect(trace.metadata.chunkCount).toBe(3);
  } finally {
    delete process.env.BELLA_STREAM_DECISION_HOLD_CHARS;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
