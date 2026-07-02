// capture.test.ts - proxy auto-capture v1: heuristic extraction + the full loop (proxy turn ->
// memory row with provenance -> capture trace), dedup on repeat, and the kill switch.
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { proxyRoutes } from "../src/proxy";
import { extractCandidateFacts, captureEnabled } from "../src/capture";
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

test("BELLA_PROXY_CAPTURE=0 disables capture entirely", async () => {
  process.env.BELLA_PROXY_CAPTURE = "0";
  const { app, sql, close } = await makeCtx();
  try {
    await chat(app, "I prefer metric units.");
    await new Promise((r) => setTimeout(r, 400));
    const rows = await sql`SELECT count(*)::int AS n FROM memory_entry`;
    expect(Number(rows[0]!.n)).toBe(0);
  } finally {
    delete process.env.BELLA_PROXY_CAPTURE;
    await close();
  }
}, TEST_TIMEOUT_MS);
