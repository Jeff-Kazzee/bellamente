import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { searchRoutes } from "../src/search";
import { inspectRoutes, recordTrace } from "../src/inspect";
import { proxyRoutes } from "../src/proxy";
import { ORG_ID, DEFAULT_CONTAINER_TAG } from "../src/util";
import type { Embed } from "../src/embed";

const memId = "m".repeat(22);
const spaceId = "s".repeat(22);
const userVector = "[1,0,0,0]";
const TEST_TIMEOUT_MS = 15000;
const encoder = new TextEncoder();

function sseResponse(chunks: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

type TestCtxOpts = {
  fetch?: typeof fetch;
  upstreamBaseUrl?: string;
  allowUnauthenticatedUpstream?: boolean;
  embed?: Embed;
};

async function makeCtx(opts: TestCtxOpts = {}) {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  const embed: Embed = opts.embed ?? (async ({ values }) => values.map(() => [1, 0, 0, 0]));
  await seedMemory(sql);
  return { sql, ...opts, embed, close: () => sql.end() };
}

async function seedMemory(sql: Sql) {
  await sql`
    INSERT INTO space (id, container_tag, org_id)
    VALUES (${spaceId}, ${DEFAULT_CONTAINER_TAG}, ${ORG_ID})
    ON CONFLICT (container_tag, org_id) DO NOTHING`;
  await sql`
    INSERT INTO memory_entry
      (id, org_id, space_id, memory, is_latest, version, root_memory_id, memory_embedding, memory_embedding_model)
    VALUES
      (${memId}, ${ORG_ID}, ${spaceId}, ${"John prefers dark mode"}, true, 1, ${memId}, ${userVector}::vector, ${"test-embed"})`;
}

test("POST /search records an inspectable recall trace", async () => {
  const ctx = await makeCtx();
  try {
    const app = new Hono();
    app.route("/search", searchRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "which theme", limit: 1 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const traceId = res.headers.get("x-eunoia-trace-id");
    expect(traceId).toBeTruthy();
    expect(body.traceId).toBe(traceId);
    expect(res.headers.get("x-eunoia-search-results")).toBe("1");
    expect(body.results[0].id).toBe(memId);

    const inspect = await app.request(`/inspect/${traceId}`);
    expect(inspect.status).toBe(200);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ id: traceId, kind: "search", status: "ok", query: "which theme", resultCount: 1, containerTag: null });
    expect(trace.retrieved[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.retrieved[0].similarity).toBeGreaterThan(0.99);

    const list = await app.request("/inspect?limit=not-a-number");
    expect(list.status).toBe(200);
    const { traces } = await list.json();
    expect(traces.some((t: any) => t.id === traceId)).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
test("proxy inject-only mode emits trace headers and stores injected context", async () => {
  const ctx = await makeCtx();
  try {
    await ctx.sql`
      UPDATE space SET metadata = ${ctx.sql.json({ profile: { static: ["John prefers concise answers"], dynamic: [] } })}
      WHERE id = ${spaceId}`;

    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eunoia-user-id": "external-user-1",
        "x-eunoia-proxy-mode": "inject-only",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-eunoia-context-modified")).toBe("true");
    expect(res.headers.get("x-eunoia-tool-intercept")).toBe("searchMemory");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("false");
    const body = await res.json();
    const traceId = body.traceId;
    expect(res.headers.get("x-eunoia-trace-id")).toBe(traceId);

    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "context_injected", userId: "external-user-1" });
    expect(trace.query).toContain("Help me choose a theme");
    expect(trace.injected.map((i: any) => i.type)).toEqual(["tool", "profile"]);
    expect(trace.injected[1].content).toContain("John prefers concise answers");
    expect(trace.metadata.injectOnly).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy defaults to a local loopback upstream without auth", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    upstreamCalls.push({ input: String(input), headers: init?.headers, body: JSON.parse(String(init?.body ?? "{}")) });
    expect(String(input)).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect((init?.headers as Headers).get("authorization")).toBeNull();
    return new Response(
      JSON.stringify({ id: "chatcmpl-local-default", choices: [{ message: { role: "assistant", content: "Local answer." } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const ctx = await makeCtx({ fetch: fetcher });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Use the local model" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Local answer.");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "answered", resultCount: 0 });
    expect(trace.metadata).toMatchObject({ memoryRound: false, upstreamStatus: 200 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy treats 127/8 and mapped loopback upstreams as local without auth", async () => {
  const cases = [
    { base: "http://127.0.1.1:11434/v1", expected: "http://127.0.1.1:11434/v1/chat/completions" },
    { base: "http://[::ffff:127.0.0.1]:11434/v1", expected: "http://[::ffff:7f00:1]:11434/v1/chat/completions" },
    { base: "http://model.localhost:11434/v1", expected: "http://model.localhost:11434/v1/chat/completions" },
  ];

  for (const { base, expected } of cases) {
    const upstreamCalls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      upstreamCalls.push(String(input));
      expect(String(input)).toBe(expected);
      expect((init?.headers as Headers).get("authorization")).toBeNull();
      return new Response(
        JSON.stringify({ id: "chatcmpl-local-range", choices: [{ message: { role: "assistant", content: "Local answer." } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: base });
    try {
      const app = new Hono();
      app.route("/v1", proxyRoutes(ctx as any));
      app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Use the local model" }] }),
      });

      expect(res.status).toBe(200);
      expect(upstreamCalls).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  }
}, TEST_TIMEOUT_MS);
test("proxy forwards upstream, runs searchMemory tool calls, reinvokes, and records an answered trace", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push({ input: String(input), body: requestBody, headers: init?.headers });

    if (upstreamCalls.length === 1) {
      expect(requestBody.tools[0]).toMatchObject({ type: "function", function: { name: "searchMemory" } });
      expect(requestBody.messages[0]).toMatchObject({ role: "system" });
      expect(requestBody.messages[0].content).toContain("John prefers concise answers");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tool",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_memory_1",
                    type: "function",
                    function: { name: "searchMemory", arguments: JSON.stringify({ queries: ["which theme"] }) },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    expect(requestBody.tool_choice).toBe("none");
    const toolMessage = requestBody.messages.find((m: any) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "call_memory_1" });
    const payload = JSON.parse(toolMessage.content);
    expect(payload).toMatchObject({ type: "eunoia_memory_results", queries: ["which theme"] });
    expect(payload.results[0]).toMatchObject({ id: memId, content: "John prefers dark mode" });

    return new Response(
      JSON.stringify({ id: "chatcmpl-final", choices: [{ message: { role: "assistant", content: "Use dark mode." } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    await ctx.sql`
      UPDATE space SET metadata = ${ctx.sql.json({ profile: { static: ["John prefers concise answers"], dynamic: [] } })}
      WHERE id = ${spaceId}`;

    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eunoia-user-id": "external-user-2" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-eunoia-context-modified")).toBe("true");
    expect(res.headers.get("x-eunoia-tool-intercept")).toBe("searchMemory");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("true");
    expect(res.headers.get("x-eunoia-search-results")).toBe("1");
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Use dark mode.");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "answered", userId: "external-user-2", resultCount: 1, injectedCount: 1 });
    expect(trace.queries).toEqual(["which theme"]);
    expect(trace.retrieved[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.injected[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.metadata).toMatchObject({ memoryRound: true, toolCallCount: 1, upstreamStatus: 200, firstUpstreamStatus: 200, toolSearchTimedOut: false });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

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

    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eunoia-user-id": "external-user-stream" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-eunoia-streaming")).toBe("true");
    expect(res.headers.get("x-eunoia-context-modified")).toBe("true");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("false");
    expect(res.headers.get("x-eunoia-tool-intercept")).toBeNull();
    const streamText = await res.text();
    expect(streamText).toContain("dark mode");
    expect(streamText).toContain("data: [DONE]");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
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
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eunoia-user-id": "external-user-stream-round" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-eunoia-streaming")).toBe("true");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("true");
    expect(res.headers.get("x-eunoia-search-results")).toBe("1");
    expect(res.headers.get("x-eunoia-tool-intercept")).toBe("searchMemory");
    const streamText = await res.text();
    expect(streamText).toContain("Use dark mode.");
    expect(streamText).toContain("data: [DONE]");
    expect(streamText).not.toContain("call_mem_1");
    expect(streamText).not.toContain("tool_calls");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
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
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

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
    expect(res.headers.get("x-eunoia-streaming")).toBe("true");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("false");
    const streamText = await res.text();
    expect(streamText).toContain("call_weather_1");
    expect(streamText).toContain("lookupWeather");
    expect(streamText).toContain("data: [DONE]");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
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
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-eunoia-memory-round")).toBe("true");
    expect(res.headers.get("x-eunoia-search-results")).toBe("0");
    const streamText = await res.text();
    expect(streamText).toContain("Pick whichever theme you like.");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
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
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

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
    expect(res.headers.get("x-eunoia-streaming")).toBe("true");
    expect(res.headers.get("x-eunoia-tool-passthrough")).toBe("true");
    expect(res.headers.get("x-eunoia-context-modified")).toBe("false");
    const streamText = await res.text();
    expect(streamText).toContain("Already handled");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "streamed_passthrough", resultCount: 0, injectedCount: 0 });
    expect(trace.metadata).toMatchObject({ hasToolResults: true, streaming: true, upstreamStatus: 200 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
test("proxy returns upstream external tool calls without running the memory loop", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    expect(requestBody.tools.map((tool: any) => tool.function?.name)).toEqual(["searchMemory", "lookupWeather"]);
    return new Response(
      JSON.stringify({
        id: "chatcmpl-external-tool",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_weather_1",
                  type: "function",
                  function: { name: "lookupWeather", arguments: JSON.stringify({ city: "Denver" }) },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "What is the weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookupWeather",
              description: "Look up weather.",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(res.headers.get("x-eunoia-context-modified")).toBe("true");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("false");
    expect(res.headers.get("x-eunoia-search-results")).toBe("0");
    const body = await res.json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("lookupWeather");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_tool_calls", resultCount: 0, injectedCount: 0 });
    expect(trace.metadata).toMatchObject({ memoryRound: false, memoryToolCallCount: 0, externalToolCallCount: 1 });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
test("proxy passthrough forwards existing tool results without reinjecting", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    return new Response(
      JSON.stringify({ id: "chatcmpl-pass", choices: [{ message: { role: "assistant", content: "Already handled." } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [
          { role: "user", content: "Use the existing tool result" },
          { role: "tool", tool_call_id: "call_existing", content: "{}" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].tools).toBeUndefined();
    expect(res.headers.get("x-eunoia-tool-passthrough")).toBe("true");
    expect(res.headers.get("x-eunoia-context-modified")).toBe("false");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("false");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "passthrough", resultCount: 0, injectedCount: 0 });
    expect(trace.metadata.hasToolResults).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy degrades to empty memory results when local memory search fails", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body ?? "{}"));
    upstreamCalls.push(requestBody);
    if (upstreamCalls.length === 1) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tool-error",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_memory_error",
                    type: "function",
                    function: { name: "searchMemory", arguments: JSON.stringify({ queries: ["which theme"] }) },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Second round: the model must receive an explicit "memory unavailable" tool result, not a dead turn.
    const toolMessage = requestBody.messages.find((m: any) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "call_memory_error" });
    const payload = JSON.parse(toolMessage.content);
    expect(payload).toMatchObject({ type: "eunoia_memory_results", error: "memory_search_unavailable", results: [] });
    return new Response(
      JSON.stringify({ id: "chatcmpl-degraded", choices: [{ message: { role: "assistant", content: "Answer without memory." } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const failingEmbed: Embed = async () => {
    throw new Error("embedding unavailable");
  };

  const ctx = await makeCtx({
    fetch: fetcher,
    upstreamBaseUrl: "https://upstream.example/v1",
    allowUnauthenticatedUpstream: true,
    embed: failingEmbed,
  });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    // A recall failure no longer discards the model's successful tool-call turn: the proxy continues
    // with empty results (same as the timeout path) and the user still gets an answer.
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-eunoia-context-modified")).toBe("true");
    expect(res.headers.get("x-eunoia-memory-round")).toBe("true");
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Answer without memory.");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "answered", resultCount: 0, injectedCount: 0 });
    expect(trace.queries).toEqual(["which theme"]);
    expect(trace.metadata).toMatchObject({
      memoryRound: true,
      toolCallCount: 1,
      toolSearchFailed: true,
      toolSearchError: "embedding unavailable",
      toolSearchTimedOut: false,
    });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("trace pruning is batched (every 25 writes) and bounds the table to the retention", async () => {
  process.env.EUNOIA_TRACE_RETENTION = "5";
  const ctx = await makeCtx();
  try {
    const count = async () =>
      Number((await ctx.sql`SELECT count(*)::int AS n FROM recall_trace`)[0]!.n);
    for (let i = 0; i < 24; i++) await recordTrace(ctx.sql, { kind: "search", query: `q${i}` });
    expect(await count()).toBe(24); // no prune yet — pruning no longer runs on every write
    await recordTrace(ctx.sql, { kind: "search", query: "q24" }); // 25th write triggers the prune
    expect(await count()).toBe(5); // ...and bounds the table to the retention
  } finally {
    delete process.env.EUNOIA_TRACE_RETENTION;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy aborts a hung upstream after EUNOIA_UPSTREAM_TIMEOUT_MS", async () => {
  process.env.EUNOIA_UPSTREAM_TIMEOUT_MS = "50";
  const fetcher: typeof fetch = (_input, init) =>
    new Promise((_, reject) => {
      // Simulate a hung upstream that only ends when the caller aborts.
      (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
        reject((init!.signal as AbortSignal).reason ?? new Error("aborted")),
      );
    });

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Hello" }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Upstream request failed");

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error" });
    expect(String(trace.metadata.error)).toContain("timed out after 50ms");
  } finally {
    delete process.env.EUNOIA_UPSTREAM_TIMEOUT_MS;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy errors a stalled stream after EUNOIA_STREAM_IDLE_TIMEOUT_MS", async () => {
  process.env.EUNOIA_STREAM_IDLE_TIMEOUT_MS = "50";
  const fetcher: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
          // ...then go silent forever: never enqueue again, never close.
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

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

    const traceId = res.headers.get("x-eunoia-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "stream_error" });
    expect(String(trace.metadata.error)).toContain("stalled");
  } finally {
    delete process.env.EUNOIA_STREAM_IDLE_TIMEOUT_MS;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
