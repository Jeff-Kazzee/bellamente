import { test, expect } from "bun:test";
import { Hono } from "hono";
import { searchRoutes, Q } from "../src/search";
import { inspectRoutes, recordTrace } from "../src/inspect";
import { proxyRoutes, runToolSearch } from "../src/proxy";
import { ORG_ID, DEFAULT_CONTAINER_TAG } from "../src/util";
import type { Embed } from "../src/embed";
import { makeCtx, memId, spaceId, TEST_TIMEOUT_MS } from "./proxy-fixture";

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
    const traceId = res.headers.get("x-bella-trace-id");
    expect(traceId).toBeTruthy();
    expect(body.traceId).toBe(traceId);
    expect(res.headers.get("x-bella-search-results")).toBe("1");
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
        "x-bella-user-id": "external-user-1",
        "x-bella-proxy-mode": "inject-only",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-bella-context-modified")).toBe("true");
    expect(res.headers.get("x-bella-tool-intercept")).toBe("searchMemory");
    expect(res.headers.get("x-bella-memory-round")).toBe("false");
    const body = await res.json();
    const traceId = body.traceId;
    expect(res.headers.get("x-bella-trace-id")).toBe(traceId);

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
  process.env.BELLA_CAPTURE_DISTILL = "0"; // asserts EXACT upstream call counts; capture's distill call would add one
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

    const traceId = res.headers.get("x-bella-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "answered", resultCount: 0 });
    expect(trace.metadata).toMatchObject({ memoryRound: false, upstreamStatus: 200 });
  } finally {
    delete process.env.BELLA_CAPTURE_DISTILL;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy treats 127/8 and mapped loopback upstreams as local without auth", async () => {
  process.env.BELLA_CAPTURE_DISTILL = "0"; // asserts EXACT upstream call counts; capture's distill call would add one
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
  delete process.env.BELLA_CAPTURE_DISTILL;
}, TEST_TIMEOUT_MS);
test("proxy forwards upstream, runs searchMemory tool calls, reinvokes, and records an answered trace", async () => {
  process.env.BELLA_CAPTURE_DISTILL = "0"; // asserts EXACT upstream call counts; capture's distill call would add one
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
    expect(payload).toMatchObject({ type: "bella_memory_results", queries: ["which theme"] });
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
      headers: { "content-type": "application/json", "x-bella-user-id": "external-user-2" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Help me choose a theme" }] }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-bella-context-modified")).toBe("true");
    expect(res.headers.get("x-bella-tool-intercept")).toBe("searchMemory");
    expect(res.headers.get("x-bella-memory-round")).toBe("true");
    expect(res.headers.get("x-bella-search-results")).toBe("1");
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Use dark mode.");

    const traceId = res.headers.get("x-bella-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "answered", userId: "external-user-2", resultCount: 1, injectedCount: 1 });
    expect(trace.queries).toEqual(["which theme"]);
    expect(trace.retrieved[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.injected[0]).toMatchObject({ type: "memory", id: memId, content: "John prefers dark mode" });
    expect(trace.metadata).toMatchObject({ memoryRound: true, toolCallCount: 1, upstreamStatus: 200, firstUpstreamStatus: 200, toolSearchTimedOut: false });
  } finally {
    delete process.env.BELLA_CAPTURE_DISTILL;
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
    expect(res.headers.get("x-bella-context-modified")).toBe("true");
    expect(res.headers.get("x-bella-memory-round")).toBe("false");
    expect(res.headers.get("x-bella-search-results")).toBe("0");
    const body = await res.json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("lookupWeather");

    const traceId = res.headers.get("x-bella-trace-id");
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
    expect(res.headers.get("x-bella-tool-passthrough")).toBe("true");
    expect(res.headers.get("x-bella-context-modified")).toBe("false");
    expect(res.headers.get("x-bella-memory-round")).toBe("false");

    const traceId = res.headers.get("x-bella-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "passthrough", resultCount: 0, injectedCount: 0 });
    expect(trace.metadata.hasToolResults).toBe(true);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy degrades to empty memory results when local memory search fails", async () => {
  process.env.BELLA_CAPTURE_DISTILL = "0"; // asserts EXACT upstream call counts; capture's distill call would add one
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
    expect(payload).toMatchObject({ type: "bella_memory_results", error: "memory_search_unavailable", results: [] });
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
    expect(res.headers.get("x-bella-context-modified")).toBe("true");
    expect(res.headers.get("x-bella-memory-round")).toBe("true");
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Answer without memory.");

    const traceId = res.headers.get("x-bella-trace-id");
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
    delete process.env.BELLA_CAPTURE_DISTILL;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("trace pruning is batched (every 25 writes) and bounds the table to the retention", async () => {
  process.env.BELLA_TRACE_RETENTION = "5";
  const ctx = await makeCtx();
  try {
    const count = async () =>
      Number((await ctx.sql`SELECT count(*)::int AS n FROM recall_trace`)[0]!.n);
    for (let i = 0; i < 24; i++) await recordTrace(ctx.sql, { kind: "search", query: `q${i}` });
    expect(await count()).toBe(24); // no prune yet — pruning no longer runs on every write
    await recordTrace(ctx.sql, { kind: "search", query: "q24" }); // 25th write triggers the prune
    expect(await count()).toBe(5); // ...and bounds the table to the retention
  } finally {
    delete process.env.BELLA_TRACE_RETENTION;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("proxy aborts a hung upstream after BELLA_UPSTREAM_TIMEOUT_MS", async () => {
  process.env.BELLA_UPSTREAM_TIMEOUT_MS = "50";
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

    const traceId = res.headers.get("x-bella-trace-id");
    const inspect = await app.request(`/inspect/${traceId}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error" });
    expect(String(trace.metadata.error)).toContain("timed out after 50ms");
  } finally {
    delete process.env.BELLA_UPSTREAM_TIMEOUT_MS;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);








test("buffered memory round returns 502 when the second upstream call fails", async () => {
  const upstreamCalls: any[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamCalls.push(JSON.parse(String(init?.body ?? "{}")));
    if (upstreamCalls.length === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_buf_1", type: "function", function: { name: "searchMemory", arguments: '{"queries":["which theme"]}' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("buffered second call exploded (test)");
  };
  const ctx = await makeCtx({ fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true });
  try {
    const app = new Hono();
    app.route("/v1", proxyRoutes(ctx as any));
    app.route("/inspect", inspectRoutes({ sql: ctx.sql }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "Which theme should I use?" }] }),
    });

    expect(res.status).toBe(502);
    expect(upstreamCalls).toHaveLength(2);
    const inspect = await app.request(`/inspect/${res.headers.get("x-bella-trace-id")}`);
    const { trace } = await inspect.json();
    expect(trace).toMatchObject({ kind: "proxy", status: "upstream_error", resultCount: 1 });
    expect(trace.metadata).toMatchObject({ memoryRound: true, firstUpstreamStatus: 200 });
    expect(String(trace.metadata.error)).toContain("buffered second call exploded");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);


test("runToolSearch records an ok tool_search trace when invoked directly", async () => {
  const ctx = await makeCtx();
  try {
    const results = await runToolSearch(ctx as any, ["which theme"], { userId: "direct-user", containerTag: DEFAULT_CONTAINER_TAG });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(memId);

    const rows = await ctx.sql`SELECT kind, status, user_id FROM recall_trace WHERE kind = ${"tool_search"}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tool_search", status: "ok", user_id: "direct-user" });
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("runToolSearch records an error tool_search trace and rethrows on search failure", async () => {
  const ctx = await makeCtx({
    embed: async () => {
      throw new Error("embedder offline (direct)");
    },
  });
  try {
    await expect(runToolSearch(ctx as any, ["which theme"], { containerTag: DEFAULT_CONTAINER_TAG })).rejects.toThrow("embedder offline");
    const rows = await ctx.sql`SELECT kind, status FROM recall_trace WHERE kind = ${"tool_search"}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("error");
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);





test("runToolSearch preserves the diversified memory order — the proxy merge must not re-sort by score (P1.4)", async () => {
  const ctx = await makeCtx();
  const originalThreshold = Q.SIMILARITY_THRESHOLD;
  try {
    Q.SIMILARITY_THRESHOLD = 0.3; // fixture sims (0.6..0.35) sit below some engine-calibrated default floors
    const TAG = "mmr_tool_test";
    const SPACE = "mmrtoolspace".padEnd(22, "x");
    await ctx.sql`INSERT INTO space (id, container_tag, org_id) VALUES (${SPACE}, ${TAG}, ${ORG_ID})`;
    // Same shape as the P1.4 fixtures in search.test.ts: three near-identical dups + one distinct
    // relevant memory; texts avoid the query's tokens so only vector rank + MMR set the order.
    const dupA = "tooldupa".padEnd(22, "x");
    const distinct = "tooldist".padEnd(22, "x");
    const rows = [
      { id: dupA, memory: "dark mode on every surface", vec: "[0.6,0.8,0,0]" },
      { id: "tooldupb".padEnd(22, "x"), memory: "dark mode on all surfaces", vec: "[0.59,0.8074,0,0]" },
      { id: "tooldupc".padEnd(22, "x"), memory: "dark mode everywhere always", vec: "[0.58,0.8146,0,0]" },
      { id: distinct, memory: "compact font sizing everywhere", vec: "[0.35,0,0.9368,0]" },
    ];
    for (const r of rows) {
      await ctx.sql`
        INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, version, root_memory_id, memory_embedding, memory_embedding_model)
        VALUES (${r.id}, ${ORG_ID}, ${SPACE}, ${r.memory}, true, 1, ${r.id}, ${r.vec}::vector, ${"test-embed"})`;
    }
    const results = await runToolSearch(ctx as any, ["preferred ui theme"], { containerTag: TAG, recordTrace: false });
    // searchMemories returns the MMR order [dupA, distinct, dupB, dupC]; a score re-sort in the
    // proxy merge would bury the distinct memory at #4 again (Codex review of PR #88, finding 1).
    expect(results[0]!.id).toBe(dupA);
    expect(results.slice(0, 3).map((r) => r.id)).toContain(distinct);
  } finally {
    Q.SIMILARITY_THRESHOLD = originalThreshold;
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);

test("runToolSearch keeps keyword-only hits from sinking below cosine hits (rank order, not similarity)", async () => {
  const ctx = await makeCtx();
  try {
    // Seeded memory: "John prefers dark mode", embedding [1,0,0,0] == the fake query embedding (cosine 1.0).
    // Add a keyword-only memory: contains the literal query token, embedding orthogonal (cosine 0.0).
    const kwId = "kwtool".padEnd(22, "x");
    await ctx.sql`
      INSERT INTO memory_entry (id, org_id, space_id, memory, is_latest, version, root_memory_id, memory_embedding, memory_embedding_model)
      VALUES (${kwId}, ${ORG_ID}, ${spaceId}, ${"deploy code XK-42-BETA is live"}, true, 1, ${kwId}, ${"[0,1,0,0]"}::vector, ${"test-embed"})`;
    const results = await runToolSearch(ctx as any, ["XK-42-BETA"], { containerTag: DEFAULT_CONTAINER_TAG, recordTrace: false });
    // Both rank #1 in their leg (RRF tie); the literal match wins the tie in searchMemories, and the
    // proxy merge must PRESERVE that fused order instead of re-sorting by cosine similarity.
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.id).toBe(kwId);
  } finally {
    await ctx.close();
  }
}, TEST_TIMEOUT_MS);
