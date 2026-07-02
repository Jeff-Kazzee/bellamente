// capture.test.ts - proxy auto-capture v1: heuristic extraction + the full loop (proxy turn ->
// memory row with provenance -> capture trace), dedup on repeat, and the kill switch.
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { proxyRoutes } from "../src/proxy";
import { extractCandidateFacts, captureEnabled, captureFromTurn } from "../src/capture";
import { DEFAULT_CONTAINER_TAG } from "../src/util";
import { EMBED_DIM } from "../src/embed-common";
import type { Embed } from "../src/embed";

const TEST_TIMEOUT_MS = 20000;

test("extractCandidateFacts: keeps declarative first-person facts, drops questions/noise, caps at 3", () => {
  const text =
    "I prefer metric units. What's the weather like today? I live in Boulder. " +
    "Remember that my dog is called Pico. I use Neovim. ok. Can you help me?";
  const facts = extractCandidateFacts(text);
  expect(facts).toEqual(["I prefer metric units.", "I live in Boulder.", "my dog is called Pico."]); // cap 3, question + "ok." dropped
  expect(extractCandidateFacts("Is this a question? Why though?")).toEqual([]);
  expect(extractCandidateFacts("i'm allergic to peanuts")).toEqual(["i'm allergic to peanuts"]);
  expect(extractCandidateFacts("short")).toEqual([]);
});

test("sensitive disclosures are NEVER captured (credentials, financial/government IDs, medical)", () => {
  const sensitive = [
    "my password is hunter2.",
    "My API key is sk-abc123def.",
    "I'm HIV positive.",
    "my social security number is 123-45-6789.",
    "I am depressed lately.",
    "my credit card number is 4111 1111 1111 1111.",
    "Remember that my bank account PIN is 0000.",
  ];
  for (const s of sensitive) {
    expect(extractCandidateFacts(s)).toEqual([]);
  }
  // ...while adjacent benign facts in the same message still capture.
  expect(extractCandidateFacts("my password is hunter2. I prefer metric units.")).toEqual(["I prefer metric units."]);
});

test("captureEnabled: on by default, BELLA_PROXY_CAPTURE=0 kills it", () => {
  try {
    expect(captureEnabled()).toBe(true);
    process.env.BELLA_PROXY_CAPTURE = "0";
    expect(captureEnabled()).toBe(false);
    process.env.BELLA_PROXY_CAPTURE = "1";
    expect(captureEnabled()).toBe(true);
  } finally {
    delete process.env.BELLA_PROXY_CAPTURE;
  }
});

// --- integration: an answered proxy turn captures a fact, visibly and deduplicated ---

const unit = [1, ...new Array(EMBED_DIM - 1).fill(0)];
const embed: Embed = async ({ values }) => values.map(() => unit);

async function makeCtx() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({ id: "chatcmpl-x", choices: [{ message: { role: "assistant", content: "Noted." } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const ctx = { sql, embed, fetch: fetcher, upstreamBaseUrl: "https://upstream.example/v1", allowUnauthenticatedUpstream: true };
  const app = new Hono();
  app.route("/v1", proxyRoutes(ctx as any));
  return { app, sql, close: () => sql.end() };
}

async function chat(app: Hono, content: string) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content }] }),
  });
}

// Capture is fire-and-forget from the proxy, so poll briefly for the async write to land.
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 4000): Promise<T | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

test("an answered turn captures the fact with provenance + a capture trace; repeats dedupe", async () => {
  const { app, sql, close } = await makeCtx();
  try {
    const res = await chat(app, "I prefer metric units. What's a good pasta recipe?");
    expect(res.status).toBe(200);

    const row = await waitFor(async () => {
      const rows = await sql`SELECT memory, is_inference, metadata FROM memory_entry WHERE memory = ${"I prefer metric units."}`;
      return rows[0];
    });
    expect(row).toBeDefined();
    expect(row!.is_inference).toBe(true); // captured, not user-asserted — distinguishable forever
    expect(row!.metadata?.source).toBe("proxy_capture");
    expect(row!.metadata?.proxyTraceId).toBe(res.headers.get("x-bella-trace-id"));

    const trace = await waitFor(async () => {
      const rows = await sql`SELECT status, retrieved, metadata FROM recall_trace WHERE kind = 'capture'`;
      return rows[0];
    });
    expect(trace).toBeDefined();
    expect(trace!.status).toBe("ok");
    expect(trace!.metadata?.actions).toEqual(["created"]);

    // Saying it again reinforces via the standard dedup path instead of duplicating.
    await chat(app, "I prefer metric units. Also—thanks!");
    await waitFor(async () => {
      const rows = await sql`SELECT id FROM recall_trace WHERE kind = 'capture'`;
      return rows.length >= 2 ? rows : undefined;
    });
    const count = await sql`SELECT count(*)::int AS n FROM memory_entry WHERE memory = ${"I prefer metric units."}`;
    expect(Number(count[0]!.n)).toBe(1);

    // PATCH-editing a captured memory keeps its provenance: is_inference carries into the new version
    // (a typo fix must not silently reclassify a captured fact as user-asserted).
    const { memoriesRoutes } = await import("../src/memories");
    const memApp = new Hono();
    memApp.route("/memories", memoriesRoutes({ sql, embed }));
    const [memRow] = await sql`SELECT id FROM memory_entry WHERE memory = ${"I prefer metric units."} AND is_latest = true`;
    const patched = await memApp.request(`/memories/${memRow!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "I prefer metric units everywhere." }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.memory.isInference).toBe(true);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("BELLA_PROXY_CAPTURE=0 disables capture entirely: no memory write AND no capture trace", async () => {
  process.env.BELLA_PROXY_CAPTURE = "0";
  const { app, sql, close } = await makeCtx();
  try {
    await chat(app, "I prefer metric units.");
    await new Promise((r) => setTimeout(r, 400));
    const rows = await sql`SELECT count(*)::int AS n FROM memory_entry`;
    expect(Number(rows[0]!.n)).toBe(0);
    // Disabled means fully silent — not even a capture trace row (the proxy trace is separate).
    const traces = await sql`SELECT count(*)::int AS n FROM recall_trace WHERE kind = 'capture'`;
    expect(Number(traces[0]!.n)).toBe(0);
  } finally {
    delete process.env.BELLA_PROXY_CAPTURE;
    await close();
  }
}, TEST_TIMEOUT_MS);

test("captureFromTurn flattens array message parts and reads only the LAST user message", async () => {
  const { sql, close } = await makeCtx();
  try {
    const ctx = { sql, embed };
    const messages = [
      { role: "user", content: "I live in Denver." }, // an EARLIER user message — must be ignored
      { role: "assistant", content: "Noted." },
      {
        role: "user",
        content: [
          "I prefer metric units.", // bare string part
          { type: "text", text: "I use Neovim." }, // {text} object part
          { type: "image_url", image_url: { url: "https://x/y.png" } }, // no text -> contributes nothing
        ],
      },
      { role: "assistant", content: "Great." },
    ];
    await captureFromTurn(ctx, { messages, containerTag: DEFAULT_CONTAINER_TAG, proxyTraceId: "trace-array-1" });

    const rows = await sql`SELECT memory FROM memory_entry ORDER BY memory`;
    expect(rows.map((r) => r.memory)).toEqual(["I prefer metric units.", "I use Neovim."]);
    const [trace] = await sql`SELECT status, query, result_count, metadata FROM recall_trace WHERE kind = 'capture'`;
    expect(trace).toBeDefined();
    expect(trace!.status).toBe("ok");
    expect(trace!.query).toBe("I prefer metric units.\nI use Neovim."); // parts joined with newline, earlier turn absent
    expect(Number(trace!.result_count)).toBe(2);
    expect(trace!.metadata?.proxyTraceId).toBe("trace-array-1");

    // Early returns write nothing: no messages / non-string non-array content / no matching facts.
    await captureFromTurn(ctx, { messages: [], containerTag: DEFAULT_CONTAINER_TAG, proxyTraceId: "t-empty" });
    await captureFromTurn(ctx, {
      messages: [{ role: "user", content: { weird: true } }],
      containerTag: DEFAULT_CONTAINER_TAG,
      proxyTraceId: "t-object",
    });
    await captureFromTurn(ctx, {
      messages: [{ role: "user", content: "What time is it?" }],
      containerTag: DEFAULT_CONTAINER_TAG,
      proxyTraceId: "t-question",
    });
    const traces = await sql`SELECT count(*)::int AS n FROM recall_trace WHERE kind = 'capture'`;
    expect(Number(traces[0]!.n)).toBe(1); // still just the one trace from the real capture
    expect(Number((await sql`SELECT count(*)::int AS n FROM memory_entry`)[0]!.n)).toBe(2);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);

test("a failing capture write resolves quietly and records an error capture trace (never breaks the turn)", async () => {
  const { sql, close } = await makeCtx();
  try {
    const failingEmbed: Embed = async () => {
      throw new Error("embedder down");
    };
    const userId = "u".repeat(22);
    // Must RESOLVE (fire-and-forget contract) even though the write path throws inside.
    await captureFromTurn(
      { sql, embed: failingEmbed },
      {
        messages: [{ role: "user", content: "I prefer metric units." }],
        containerTag: DEFAULT_CONTAINER_TAG,
        userId,
        proxyTraceId: "trace-err-1",
      },
    );

    const [trace] = await sql`
      SELECT status, query, user_id, container_tag, result_count, metadata FROM recall_trace WHERE kind = 'capture'`;
    expect(trace).toBeDefined();
    expect(trace!.status).toBe("error");
    expect(trace!.query).toBe("I prefer metric units.");
    expect(trace!.user_id).toBe(userId);
    expect(trace!.container_tag).toBe(DEFAULT_CONTAINER_TAG);
    expect(Number(trace!.result_count)).toBe(0);
    expect(trace!.metadata?.error).toBe("embedder down");
    expect(trace!.metadata?.proxyTraceId).toBe("trace-err-1");
    // ...and nothing was stored.
    expect(Number((await sql`SELECT count(*)::int AS n FROM memory_entry`)[0]!.n)).toBe(0);
  } finally {
    await close();
  }
}, TEST_TIMEOUT_MS);
