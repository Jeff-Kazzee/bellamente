// test/mcp.test.ts — behavior tests for `bella mcp` (P1.7, issue #42), written RED first.
// Round-trips a real MCP Client <-> Server in-process via InMemoryTransport (no spawned process),
// exercising every tool through the actual MCP protocol. RED until src/mcp.ts exports makeMcpServer.
import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { EMBED_DIM } from "../src/embed-common";
import type { Embed } from "../src/embed";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeMcpServer, SECRET_GUIDANCE } from "../src/mcp"; // <-- built to satisfy these tests
import { MAX_CONTENT_CHARS } from "../src/documents"; // the shared ingest cap the MCP tool must also enforce
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // repo root (this file lives in test/)

const T = 20000;
// Constant embedder, ZERO-PADDED to the machine-resolved EMBED_DIM (repo convention — AGENTS.md,
// test/memories.test.ts `pad()`): every item is similarity 1.0, so single-item corpora always
// retrieve — these tests check the MCP round-trip + lifecycle, not embedding quality (covered
// elsewhere). A fixed small dim (e.g. 4) would mismatch `isValidVector`'s real EMBED_DIM check in
// src/embed-common.ts and silently drop every write — the schema dim and the embed dim must both
// track EMBED_DIM, exactly like every other PGlite-backed test in this repo.
const pad = (v: number[]): number[] => [...v, ...new Array(Math.max(EMBED_DIM - v.length, 0)).fill(0)];
const embed: Embed = async ({ values }) => values.map(() => pad([1, 0, 0, 0]));

async function makeCtx() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  return { sql, embed };
}

async function connect(ctx: Awaited<ReturnType<typeof makeCtx>>) {
  const server = makeMcpServer(ctx as any);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text: string = res.content?.[0]?.text ?? "";
  let json: any; try { json = JSON.parse(text); } catch {}
  return { res, text, json, isError: !!res.isError };
}

const TOOLS = ["document_ingest", "document_list", "memory_correct", "memory_forget", "memory_history", "memory_list", "memory_search", "memory_write", "trace_inspect"];

test("B1 listTools exposes exactly the 6 memory tools, each with description + inputSchema", async () => {
  const { client, close } = await connect(await makeCtx());
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
  for (const t of tools) { expect(typeof t.description).toBe("string"); expect(t.description!.length).toBeGreaterThan(0); expect(t.inputSchema).toBeTruthy(); }
  await close();
}, T);

test("B1b every WRITE tool instructs the agent not to store secrets (agent is the first line of defense)", async () => {
  const { client, close } = await connect(await makeCtx());
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
  // The write-capable tools carry the guidance; read-only tools (search/list/history) do not need it.
  for (const name of ["memory_write", "memory_correct", "document_ingest"]) {
    expect(byName[name]).toContain(SECRET_GUIDANCE.trim());
  }
  expect(SECRET_GUIDANCE.toLowerCase()).toMatch(/secret|credential|api key|password|token/);
  await close();
}, T);

test("B2 memory_write stores and memory_search retrieves it (full MCP round-trip)", async () => {
  const { client, close } = await connect(await makeCtx());
  const w = await call(client, "memory_write", { content: "The deploy token for Atlas is ZEBRA-9." });
  expect(w.isError).toBe(false);
  expect(typeof w.json?.id).toBe("string");
  const s = await call(client, "memory_search", { query: "Atlas deploy token" });
  expect(JSON.stringify(s.json?.results ?? [])).toContain("ZEBRA-9");
  await close();
}, T);

test("B3 memory_list includes a written memory", async () => {
  const { client, close } = await connect(await makeCtx());
  await call(client, "memory_write", { content: "Ben uses Neovim." });
  const l = await call(client, "memory_list", {});
  expect(JSON.stringify(l.json?.memories ?? [])).toContain("Neovim");
  await close();
}, T);

test("B4 memory_forget soft-forgets (excluded from search) and undo restores", async () => {
  const { client, close } = await connect(await makeCtx());
  const w = await call(client, "memory_write", { content: "Nightly backups at 02:00 UTC." });
  const id = w.json.id;
  await call(client, "memory_forget", { id });
  const s1 = await call(client, "memory_search", { query: "backups" });
  expect(JSON.stringify(s1.json?.results ?? [])).not.toContain("Nightly backups");
  const undo = await call(client, "memory_forget", { id, undo: true });
  expect(undo.isError).toBe(false);
  const s2 = await call(client, "memory_search", { query: "backups" });
  expect(JSON.stringify(s2.json?.results ?? [])).toContain("Nightly backups");
  await close();
}, T);

test("B5 memory_forget is a reversible soft-forget — it does NOT hard-delete the row", async () => {
  const ctx = await makeCtx();
  const { client, close } = await connect(ctx);
  const w = await call(client, "memory_write", { content: "keep the row, just forget it" });
  await call(client, "memory_forget", { id: w.json.id });
  const rows = await ctx.sql`SELECT is_forgotten FROM memory_entry WHERE memory = ${"keep the row, just forget it"}`;
  expect(rows.length).toBeGreaterThan(0); // row still physically present
  expect(rows[0].is_forgotten).toBe(true);
  await close();
}, T);

test("B6 document_ingest chunks + embeds; documents search returns a chunk", async () => {
  const { client, close } = await connect(await makeCtx());
  const d = await call(client, "document_ingest", { title: "Runbook", content: "# Runbook\n\nTo recover Atlas, run reindex then rotate the token." });
  expect(d.json?.chunkCount).toBeGreaterThanOrEqual(1);
  const s = await call(client, "memory_search", { query: "recover Atlas", searchMode: "documents" });
  expect((s.json?.results ?? []).some((r: any) => r.type === "chunk")).toBe(true);
  await close();
}, T);

test("B7 trace_inspect returns the trace produced by a prior search", async () => {
  const { client, close } = await connect(await makeCtx());
  await call(client, "memory_write", { content: "a fact to search for" });
  await call(client, "memory_search", { query: "a fact" });
  const traces = await call(client, "trace_inspect", {});
  const first = (traces.json?.traces ?? [traces.json?.trace])[0];
  expect(first).toBeTruthy();
  const one = await call(client, "trace_inspect", { traceId: first.id });
  expect(one.json?.trace?.id ?? one.json?.id).toBe(first.id);
  await close();
}, T);

// B7 only proves SOME trace exists after a search — trace_inspect's no-argument list returns the
// most recent traces, which is ambiguous the moment two searches happen close together (or
// concurrently). A caller must be able to correlate ITS OWN memory_search call to ITS OWN receipt
// without guessing among a list. That requires the traceId to ride on the memory_search response
// itself, the same way the HTTP /search route already returns `traceId` in its JSON body (see
// src/search.ts) — the MCP tool's response shape today omits it (mcp.ts toToolResult), even though
// the trace is recorded on every call.
test("memory_search returns a traceId on its own response, and trace_inspect(traceId) resolves to a receipt describing exactly that call", async () => {
  const { client, close } = await connect(await makeCtx());
  try {
    await call(client, "memory_write", { content: "a fact to search for" });
    const searched = await call(client, "memory_search", { query: "a fact" });
    expect(searched.isError).toBe(false);

    const traceId = searched.json?.traceId;
    expect(typeof traceId).toBe("string");
    expect(traceId.length).toBeGreaterThan(0);

    const inspected = await call(client, "trace_inspect", { traceId });
    expect(inspected.isError).toBe(false);
    const trace = inspected.json?.trace;
    expect(trace?.id).toBe(traceId);
    // The receipt must actually describe THIS call, not merely be A trace: same query, same result
    // count, and each retrieved item's {type,id,content} must match what the search response itself
    // returned for {type,id,text} — an id-only comparison would still pass a receipt with stale or
    // wrong stored text.
    expect(trace?.query).toBe("a fact");
    const returned = (searched.json?.results ?? []).map((r) => ({ type: r.type, id: r.id, text: r.text }));
    expect(returned.length).toBeGreaterThan(0);
    expect(trace?.resultCount).toBe(returned.length);
    const traced = (trace?.retrieved ?? []).map((t) => ({ type: t.type, id: t.id, text: t.content }));
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    expect(traced.sort(byId)).toEqual(returned.sort(byId));
  } finally {
    await close();
  }
}, T);

test("B8 all tools operate on the SAME ctx.sql (single writer — no second connection)", async () => {
  const ctx = await makeCtx();
  const { client, close } = await connect(ctx);
  await call(client, "memory_write", { content: "single-writer marker" });
  const rows = await ctx.sql`SELECT memory FROM memory_entry WHERE is_latest = true`;
  expect(rows.some((r: any) => r.memory === "single-writer marker")).toBe(true);
  await close();
}, T);

test("B9 invalid input returns isError, not an unhandled throw", async () => {
  const { client, close } = await connect(await makeCtx());
  const r = await call(client, "memory_write", {}); // missing required `content`
  expect(r.isError).toBe(true);
  await close();
}, T);

// B10 spawns the REAL `bella mcp` subcommand as a child process (not InMemoryTransport) and drives a
// real JSON-RPC initialize + tools/list over its actual stdin/stdout. This is the only way to prove
// the stdout-safety rule (SPEC-P1.7 CRITICAL): the SDK's ReadBuffer parses each stdout line as strict
// JSON-RPC (JSON.parse + schema validation) and reports ANY line that fails that as a transport error
// via `onerror` — so a clean round-trip with zero onerror calls IS the proof that no diagnostic text
// (console.log from migrations/embed-prewarm etc.) ever hit stdout. Needs the local embedder to boot
// (model is already cached on disk for this repo), hence the generous timeout.
test("B10 stdout-safety: `bella mcp` speaks ONLY JSON-RPC on stdout (diagnostics go to stderr)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bella-mcp-b10-"));
  const transport = new StdioClientTransport({
    command: process.execPath, // absolute path to the running bun — avoids any PATH/shell resolution
    args: ["run", "src/index.ts", "mcp"],
    cwd: ROOT,
    // BELLA_DATA_DIR isolates the DB from the real local install; everything else (incl. the model
    // cache, so no re-download) is inherited from the current environment.
    env: { ...process.env, BELLA_DATA_DIR: dataDir } as Record<string, string>,
  });
  const transportErrors: unknown[] = [];
  const client = new Client({ name: "mcp-b10-test", version: "0" });
  client.onerror = (e) => transportErrors.push(e);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    expect(transportErrors).toEqual([]); // no stray stdout byte ever failed JSON-RPC parsing
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60000);

test("B11 clean shutdown — client.close() + server.close() resolve without hanging", async () => {
  const { close } = await connect(await makeCtx());
  await close();
  expect(true).toBe(true);
}, T);

test("B12 document_ingest enforces the same content cap as the HTTP route (no unbounded ingest)", async () => {
  const { client, close } = await connect(await makeCtx());
  // Exactly at the cap must be accepted; one over must be rejected (isError) — the tool is a thin wrapper
  // over ingestDocument, which has no length guard of its own, so the cap MUST live on the tool schema.
  const over = await call(client, "document_ingest", { content: "x".repeat(MAX_CONTENT_CHARS + 1) });
  expect(over.isError).toBe(true);
  await close();
}, T);

test("B13 empty-string scope/id args are rejected, not silently treated as 'all' or 'list'", async () => {
  const { client, close } = await connect(await makeCtx());
  // "" is falsy and would otherwise fall through the containerTag/traceId guards → search/list ALL
  // containers, or trace_inspect would LIST instead of fetching one. .min(1) makes that an explicit error.
  expect((await call(client, "memory_search", { query: "x", containerTag: "" })).isError).toBe(true);
  expect((await call(client, "memory_list", { containerTag: "" })).isError).toBe(true);
  expect((await call(client, "trace_inspect", { traceId: "" })).isError).toBe(true);
  await close();
}, T);

test("B14 exact re-submission is a no-op (unchanged), not 'updated'", async () => {
  const { client, close } = await connect(await makeCtx());
  const w1 = await call(client, "memory_write", { content: "Ben's desk is by the window." });
  expect(w1.json?.action).toBe("created");
  // isStatic is OPTIONAL (not default(false)) — a bare resubmit must NOT count isStatic as "provided",
  // which would wrongly route it to the "updated" branch instead of "unchanged".
  const w2 = await call(client, "memory_write", { content: "Ben's desk is by the window." });
  expect(w2.json?.action).toBe("unchanged");
  await close();
}, T);

test("B15 memory_correct writes a new version; memory_history shows the whole chain", async () => {
  const { client, close } = await connect(await makeCtx());
  const w = await call(client, "memory_write", { content: "The wifi password is alpha-1." });
  const id = w.json.id;
  const corr = await call(client, "memory_correct", { id, content: "The wifi password is beta-2." });
  expect(corr.isError).toBe(false);
  expect(corr.json?.action).toBe("versioned");
  // search returns the corrected value; the chain retains BOTH versions (the inspect-and-trust story)
  const s = await call(client, "memory_search", { query: "wifi password" });
  expect(JSON.stringify(s.json?.results ?? [])).toContain("beta-2");
  const hist = await call(client, "memory_history", { id });
  const chain = (hist.json?.versions ?? []).map((v: any) => v.memory).join("|");
  expect(hist.json?.versions?.length).toBe(2);
  expect(chain).toContain("alpha-1"); // old version preserved
  expect(chain).toContain("beta-2");
  await close();
}, T);

test("B16 document_list lists ingested documents", async () => {
  const { client, close } = await connect(await makeCtx());
  await call(client, "document_ingest", { title: "Runbook", content: "# Runbook\n\nSteps to recover Atlas." });
  const dl = await call(client, "document_list", {});
  expect(dl.isError).toBe(false);
  expect((dl.json?.documents ?? []).some((d: any) => d.title === "Runbook")).toBe(true);
  await close();
}, T);

test("B17 trace_inspect filters by kind", async () => {
  const { client, close } = await connect(await makeCtx());
  await call(client, "memory_write", { content: "a fact to search" });
  await call(client, "memory_search", { query: "a fact" });
  const searches = await call(client, "trace_inspect", { kind: "search" });
  const traces = searches.json?.traces ?? [];
  expect(traces.length).toBeGreaterThan(0);
  expect(traces.every((t: any) => t.kind === "search")).toBe(true);
  const none = await call(client, "trace_inspect", { kind: "no-such-kind" });
  expect(none.isError).toBe(false); // an unknown kind is an empty list, not an error
  expect((none.json?.traces ?? []).length).toBe(0);
  await close();
}, T);

test("B18 memory_correct on a missing/empty id errors gracefully", async () => {
  const { client, close } = await connect(await makeCtx());
  expect((await call(client, "memory_correct", { id: "AAAAAAAAAAAAAAAAAAAAAA", content: "x" })).isError).toBe(true);
  expect((await call(client, "memory_correct", { id: "", content: "x" })).isError).toBe(true);
  await close();
}, T);
