// functional-e2e.ts — full-functionality release-smoke for the REAL Bellamente server.
// Boots buildApp via Bun.serve (the same path `bella serve` uses) with the REAL embedder + an
// on-disk PGlite DB, and a REAL mock-LLM upstream over HTTP. Only the LLM's "brain" is scripted;
// the memory substrate (embed -> pgvector -> fusion -> reinvocation -> trace) is fully real. This
// covers exactly the real-server / WASM-embed / real-HTTP path unit tests can't reach (AGENTS.md
// names that as the release-smoke requirement). Self-checking: exits non-zero if any behavior is wrong.
//   run:  bun run smoke
process.env.BELLA_PROXY_CAPTURE = "0"; // deterministic: no learned-memory noise mid-suite
process.env.BELLA_CAPTURE_DISTILL = "0"; // no extra upstream distill calls

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

const runDir = mkdtempSync(join(tmpdir(), "bella-fe2e-"));
process.env.BELLA_DATA_DIR = join(runDir, "data");
process.env.BELLA_LOG_DIR = join(runDir, "logs");
process.env.BELLA_CACHE_DIR ??= join(runDir, "cache");

// ---- mock LLM upstream (real HTTP server the proxy really fetches) --------------------
const enc = new TextEncoder();
const sseData = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
function sse(chunks: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const toolCall = (q: string) => ({ id: "chatcmpl-tool", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_mem_1", type: "function", function: { name: "searchMemory", arguments: JSON.stringify({ queries: [q] }) } }] } }] });
const finalAnswer = (t: string) => ({ id: "chatcmpl-final", choices: [{ message: { role: "assistant", content: t } }] });
function answerChunks(t: string) {
  const mid = Math.ceil(t.length / 2);
  return [sseData({ choices: [{ delta: { role: "assistant", content: t.slice(0, mid) } }] }),
          sseData({ choices: [{ delta: { content: t.slice(mid) }, finish_reason: "stop" }] }), "data: [DONE]\n\n"];
}
function toolCallChunksFragmented(q: string) {
  const args = JSON.stringify({ queries: [q] });
  const cut = Math.ceil(args.length / 2); // split the JSON arguments MID-STRING across two SSE chunks
  return [sseData({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_mem_1", type: "function", function: { name: "searchMemory", arguments: args.slice(0, cut) } }] } }] }),
          sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] } }] }),
          sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "data: [DONE]\n\n"];
}
async function mockUpstream(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    return new Response(JSON.stringify({ error: `unexpected upstream route: ${req.method} ${url.pathname}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  let body: any = {}; try { body = await req.json(); } catch {}
  const streaming = body.stream === true;
  const msgs: any[] = body.messages || [];
  if (msgs.some((m) => m.role === "tool")) { // reinvocation: ground the answer in what we retrieved
    const toolMsg = msgs.find((m) => m.role === "tool");
    let grounded = "(no memory found)";
    try { grounded = JSON.parse(toolMsg.content).results?.[0]?.content ?? grounded; } catch {}
    const ans = `Based on your stored memory: ${grounded}`;
    return streaming ? sse(answerChunks(ans)) : json(finalAnswer(ans));
  }
  if ((body.tools || []).some((t: any) => t?.function?.name === "searchMemory")) { // first turn: decide to search
    const user = [...msgs].reverse().find((m) => m.role === "user");
    const q = typeof user?.content === "string" ? user.content : "the question";
    return streaming ? sse(toolCallChunksFragmented(q)) : json(toolCall(q));
  }
  return streaming ? sse(answerChunks("Acknowledged.")) : json(finalAnswer("Acknowledged."));
}

// ---- harness -------------------------------------------------------------------------
let pass = 0, fail = 0; const failed: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; failed.push(name); console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const [{ makeDb, schemaForDim }, { EMBED_DIM }, { buildApp }, { makeEmbed, prewarmEmbed }, { DEFAULT_CONTAINER_TAG }, { setErrorSink, capture }, { persistErrorEventSafe }] = await Promise.all([
    import("../src/db"),
    import("../src/embed-common"),
    import("../src/index"),
    import("../src/embed"),
    import("../src/util"),
    import("../src/observe"),
    import("../src/error-store"),
  ]);

  console.log(`\n=== Bellamente full-functionality smoke (REAL embedder, on-disk DB, real HTTP) ===`);
  console.log(`embedder dim=${EMBED_DIM}  runDir=${runDir}\n`);
  console.log("[boot] prewarming real embedder...");
  const embed = makeEmbed();
  await prewarmEmbed(embed);

  const sql = await makeDb();
  setErrorSink((ev) => void persistErrorEventSafe(sql, ev)); // mirror main(): persist captured failures once the DB is open
  const migrationRows = await sql`SELECT id FROM schema_migrations ORDER BY id`;
  check("makeDb boot path applies migrations", migrationRows.length >= 1, `migrations=${migrationRows.length}`);

  const mock = Bun.serve({ port: 0, fetch: mockUpstream });
  const upstreamBaseUrl = `http://127.0.0.1:${mock.port}/v1`;
  const ctx: any = { sql, embed, upstreamBaseUrl, allowUnauthenticatedUpstream: true };
  const app = buildApp(ctx, { required: false, key: null, source: "none" } as any);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  console.log(`[boot] Bellamente server on ${base}  |  mock LLM upstream on ${upstreamBaseUrl}\n`);

  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let j: any; try { j = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, json: j, text };
  }

  try {
    // A. Health / doctor authenticity contract
    console.log("A. Health");
    const h = await req("GET", "/health");
    check("GET /health ok + service=bellamente", h.json?.ok === true && h.json?.service === "bellamente", `service=${h.json?.service}`);

    // B. Store memories (real embedder)
    console.log("\nB. Store memories (real embeddings)");
    const facts = [
      "The production deploy token for project Atlas is ZEBRA-9.",
      "Ben prefers metric units and edits code in Neovim.",
      "Nightly database backups run at 02:00 UTC to the Frankfurt bucket.",
      "Cyra owns the billing service and reviews escalations every Friday.",
      "The staging environment resets every Sunday at midnight.",
    ];
    const store = await req("POST", "/memories", { containerTag: DEFAULT_CONTAINER_TAG, dedupe: false, memories: facts.map((content) => ({ content })) });
    const ids: string[] = (store.json?.memories || []).map((m: any) => m.id);
    check("POST /memories stored all 5", ids.length === 5, `ids=${ids.length}`);
    const atlasId = ids[0];

    // C. List + detail + initial version
    console.log("\nC. List & inspect");
    const list = await req("GET", "/memories?limit=50");
    check("GET /memories lists >=5", (list.json?.memories || []).length >= 5, `count=${list.json?.memories?.length}`);
    const detail = await req("GET", `/memories/${atlasId}`);
    check("GET /memories/:id returns {memory, versions}", !!detail.json?.memory && Array.isArray(detail.json?.versions), `versions=${detail.json?.versions?.length}`);
    check("initial chain has version 1 only", detail.json?.versions?.length === 1);

    // D. Semantic search + discrimination (the core memory promise)
    console.log("\nD. Semantic retrieval");
    const q = "What is the deploy token for project Atlas?";
    const search = await req("POST", "/search", { q, searchMode: "memories", containerTag: DEFAULT_CONTAINER_TAG, limit: 5 });
    const top = search.json?.results?.[0]; // memory results carry text in `.memory` (chunks use `.content`)
    check("search returns the Atlas fact at rank 1", !!top?.memory?.includes("ZEBRA-9"), `top="${top?.memory?.slice(0, 46)}..." sim=${typeof top?.similarity === "number" ? top.similarity.toFixed(3) : top?.similarity}`);
    check("retrieval discriminates (rank-1 is about Atlas, not a distractor)", !!top?.memory?.includes("Atlas"));

    // E. Proxy memory loop — BUFFERED
    console.log("\nE. Proxy memory loop — buffered");
    const chat = await req("POST", "/v1/chat/completions", { model: "demo", messages: [{ role: "user", content: q }] });
    check("proxy responds 200", chat.status === 200, `status=${chat.status}`);
    check("x-bella-memory-round=true (memory loop actually ran)", chat.headers.get("x-bella-memory-round") === "true");
    const answer = chat.json?.choices?.[0]?.message?.content || "";
    check("answer is grounded in the retrieved memory (contains ZEBRA-9)", answer.includes("ZEBRA-9"), `answer="${answer.slice(0, 70)}"`);
    const traceId = chat.headers.get("x-bella-trace-id");
    const trace = (await req("GET", `/inspect/${traceId}`)).json?.trace;
    check("trace records retrieval of the Atlas fact", !!trace?.retrieved?.[0]?.content?.includes("ZEBRA-9"), `retrieved=${trace?.retrieved?.length}, injected=${trace?.injected?.length}`);
    check("trace metadata memoryRound=true", trace?.metadata?.memoryRound === true);

    // F. Proxy memory loop — STREAMED with FRAGMENTED tool-call args
    console.log("\nF. Proxy memory loop — streamed (fragmented tool-call arguments)");
    const chatS = await req("POST", "/v1/chat/completions", { model: "demo", stream: true, messages: [{ role: "user", content: q }] });
    check("streamed proxy responds 200", chatS.status === 200, `status=${chatS.status}`);
    check("streamed x-bella-memory-round=true", chatS.headers.get("x-bella-memory-round") === "true");
    check("streamed answer grounded (SSE body contains ZEBRA-9)", chatS.text.includes("ZEBRA-9"), `bodyLen=${chatS.text.length}`);
    const traceS = (await req("GET", `/inspect/${chatS.headers.get("x-bella-trace-id")}`)).json?.trace;
    check("fragmented tool-args reassembled → correct query in trace", (traceS?.queries || []).some((x: string) => x.includes("Atlas")), `queries=${JSON.stringify(traceS?.queries)}`);

    // G. Correction = new version (append-only chain)
    console.log("\nG. Correction / versioning");
    const patch = await req("PATCH", `/memories/${atlasId}`, { content: "The production deploy token for project Atlas is ZEBRA-9 (rotated 2026-07)." });
    check("PATCH content succeeds", patch.status === 200, `status=${patch.status}`);
    const detail2 = await req("GET", `/memories/${atlasId}`);
    check("correction appended a new version (chain length 2)", detail2.json?.versions?.length === 2, `versions=${detail2.json?.versions?.length}`);
    const latestAtlas = (detail2.json?.versions || []).find((v: any) => v.isLatest);
    check("correction persisted the supplied rotated content", latestAtlas?.memory?.includes("rotated 2026-07"), `latest="${latestAtlas?.memory}"`);

    // H. Documents: ingest -> chunk -> embed, then documents + hybrid search
    console.log("\nH. Documents & hybrid search");
    const doc = await req("POST", "/documents", { title: "Atlas Runbook", containerTag: DEFAULT_CONTAINER_TAG, content: "# Atlas Runbook\n\nThe Atlas service runs in Frankfurt. To recover Atlas after an outage, run the reindex command and then rotate the deploy token. Escalate to Cyra if billing is affected." });
    check("POST /documents ingested + chunked", doc.status === 201 && doc.json?.chunkCount >= 1, `chunks=${doc.json?.chunkCount}`);
    const docDetail = await req("GET", `/documents/${doc.json?.documentId}`);
    check("GET /documents/:id returns chunks", (docDetail.json?.chunks || []).length >= 1, `chunks=${docDetail.json?.chunks?.length}`);
    const docSearch = await req("POST", "/search", { q: "how do I recover the Atlas service after an outage?", searchMode: "documents", containerTag: DEFAULT_CONTAINER_TAG, limit: 5 });
    check("documents search returns a source chunk", docSearch.json?.results?.[0]?.type === "chunk", `top type=${docSearch.json?.results?.[0]?.type}`);
    const hybrid = await req("POST", "/search", { q: "Atlas deploy token and recovery", searchMode: "hybrid", containerTag: DEFAULT_CONTAINER_TAG, limit: 6 });
    const htypes = new Set((hybrid.json?.results || []).map((r: any) => r.type));
    check("hybrid search returns BOTH memories and chunks", htypes.has("memory") && htypes.has("chunk"), `types=${[...htypes].join(",")}`);

    // I. Ranking toggles (P1.2 recency / P1.3 keyword / P1.4 MMR legs)
    console.log("\nI. Ranking toggles");
    const pureVec = await req("POST", "/search", { q, searchMode: "memories", containerTag: DEFAULT_CONTAINER_TAG, limit: 5, keyword: false, recency: false, diversify: false });
    check("pure-vector search (keyword/recency/MMR off) still finds Atlas", !!pureVec.json?.results?.[0]?.memory?.includes("Atlas"), `top="${pureVec.json?.results?.[0]?.memory?.slice(0, 34)}"`);

    // J. Profile
    console.log("\nJ. Profile");
    const putP = await req("PUT", "/profile", { static: ["The user prefers terse, technical answers."], dynamic: [] });
    check("PUT /profile ok", putP.json?.ok === true);
    const getP = await req("GET", "/profile");
    check("GET /profile returns stored profile", (getP.json?.static || []).some((s: string) => s.includes("terse")), `static=${JSON.stringify(getP.json?.static)}`);

    // K. Forgetting lifecycle (soft-delete + undo)
    console.log("\nK. Forgetting lifecycle");
    const benId = ids[1];
    const forget = await req("POST", `/memories/${benId}/forget`, { reason: "smoke forget" });
    check("POST /forget soft-forgets exactly Ben's chain", forget.json?.forgotten === true && forget.json?.affected === 1, `affected=${forget.json?.affected}`);
    const listAfterForget = await req("GET", "/memories?limit=50");
    check("forgotten memory excluded from list", !(listAfterForget.json?.memories || []).some((m: any) => m.id === benId));
    check("forget does not hide unrelated memories", (listAfterForget.json?.memories || []).some((m: any) => m.memory?.includes("Atlas")));
    const searchForgotten = await req("POST", "/search", { q: "which editor does Ben use?", searchMode: "memories", containerTag: DEFAULT_CONTAINER_TAG, limit: 5 });
    check("forgotten memory excluded from search", !(searchForgotten.json?.results || []).some((r: any) => r.memory?.includes("Neovim")));
    const undo = await req("POST", `/memories/${benId}/forget`, { undo: true });
    check("forget undo restores exactly Ben's chain", undo.json?.forgotten === false && undo.json?.affected === 1, `affected=${undo.json?.affected}`);

    // L. Export / import portability + temporal validity (asOf)
    console.log("\nL. Export / import portability + temporal asOf recall");
    const exp = await req("GET", "/export");
    check("GET /export produces a portable bellamente-export v1", exp.json?.format === "bellamente-export" && exp.json?.version === 1, `containers=${exp.json?.containers?.length}`);
    const pg2 = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
    const sql2 = makePgliteSql(pg2); await sql2.unsafe(schemaForDim(EMBED_DIM));
    const app2 = buildApp({ sql: sql2, embed } as any, { required: false, key: null, source: "none" } as any);
    const app2req = async (p: string, b: unknown) => { const r = await app2.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return r.json() as any; };
    const imp = await app2req("/import", exp.json);
    check("POST /import restores all 5 chains into a FRESH instance", imp?.imported?.chains === 5, `imported=${JSON.stringify(imp?.imported)}`);
    check("POST /import preserves all 6 memory versions", imp?.imported?.versions === 6, `imported=${JSON.stringify(imp?.imported)}`);
    const search2 = await app2req("/search", { q: "deploy token for Atlas", searchMode: "memories", containerTag: DEFAULT_CONTAINER_TAG, limit: 5 });
    check("imported instance retrieves the Atlas fact (portability proven)", !!search2?.results?.[0]?.memory?.includes("ZEBRA-9"), `top="${search2?.results?.[0]?.memory?.slice(0, 38)}"`);
    const v = (o: any) => ({ isStatic: false, isInference: false, isForgotten: false, forgetAfter: null, forgetReason: null, metadata: null, sourceCount: 1, memoryRelations: {}, ...o });
    const windowed = { format: "bellamente-export", version: 1, exportedAt: new Date().toISOString(), embedModel: "x", documents: [], provenance: [],
      containers: [{ containerTag: "temporal", profile: null, chains: [{ versions: [
        v({ exportId: "tw1", parentExportId: null, version: 1, isLatest: false, memory: "The on-call engineer for 2020 was Dale.", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2021-01-01T00:00:00Z", validFrom: "2020-01-01T00:00:00Z", validTo: "2021-01-01T00:00:00Z" }),
        v({ exportId: "tw2", parentExportId: "tw1", version: 2, isLatest: true, memory: "The on-call engineer is now Eli.", createdAt: "2021-01-01T00:00:00Z", updatedAt: "2021-01-01T00:00:00Z", validFrom: "2021-01-01T00:00:00Z", validTo: null }),
      ] }] }] };
    await app2req("/import", windowed);
    const asOfIn = await app2req("/search", { q: "who was the on-call engineer?", searchMode: "memories", containerTag: "temporal", limit: 5, asOf: "2020-06-01T00:00:00Z" });
    check("asOf INSIDE the 2020 window recalls Dale and excludes future Eli", (asOfIn?.results || []).some((r: any) => r.memory?.includes("Dale")) && !(asOfIn?.results || []).some((r: any) => r.memory?.includes("Eli")), `results=${JSON.stringify((asOfIn?.results || []).map((r: any) => r.memory?.slice(0, 20)))}`);
    const asOfNow = await app2req("/search", { q: "who was the on-call engineer?", searchMode: "memories", containerTag: "temporal", limit: 5, asOf: "2023-01-01T00:00:00Z" });
    check("asOf AFTER the window recalls the current version (Eli), not Dale", (asOfNow?.results || []).some((r: any) => r.memory?.includes("Eli")) && !(asOfNow?.results || []).some((r: any) => r.memory?.includes("Dale")), `results=${JSON.stringify((asOfNow?.results || []).map((r: any) => r.memory?.slice(0, 20)))}`);
    await sql2.end().catch(() => {});

    // M. Observability (trace list) + hard delete
    console.log("\nM. Observability & hard delete");
    const traces = await req("GET", "/inspect?limit=100");
    const kinds = new Set((traces.json?.traces || []).map((t: any) => t.kind));
    check("GET /inspect lists recorded traces incl. proxy", (traces.json?.traces || []).length >= 3 && kinds.has("proxy"), `count=${traces.json?.traces?.length}, kinds=${[...kinds].join(",")}`);
    const del = await req("DELETE", `/memories/${ids[4]}`);
    check("DELETE hard-removes exactly the staging chain", del.json?.deleted === 1, `deleted=${del.json?.deleted}`);
    const gone = await req("GET", `/memories/${ids[4]}`);
    check("deleted memory is gone (404)", gone.status === 404, `status=${gone.status}`);
    const listAfterDelete = await req("GET", "/memories?limit=50");
    check("delete does not remove unrelated memories", (listAfterDelete.json?.memories || []).some((m: any) => m.memory?.includes("Cyra")));

    // N. Error observability: capture -> redacted store -> /errors, on the REAL server + real on-disk DB.
    console.log("\nN. Error observability");
    const errEmpty = await req("GET", "/errors");
    check("GET /errors is live and empty on a clean boot", Array.isArray(errEmpty.json?.errors) && errEmpty.json.errors.length === 0, `errors=${errEmpty.json?.errors?.length}`);
    const SMK = "SMOKESECRET_error_zzz"; // if this ever appears in /errors, redaction failed
    for (let i = 0; i < 2; i++) capture(new Error(SMK), { category: "embed", code: "SMOKE_FAIL", userId: "smoke@secret.example", query: SMK });
    await new Promise((r) => setTimeout(r, 400)); // fire-and-forget writes land
    const errList = await req("GET", "/errors");
    const grp = (errList.json?.errors || []).find((e: any) => e.code === "SMOKE_FAIL");
    check("captured failures land grouped in /errors (count reflects repeats)", grp?.count === 2, `count=${grp?.count}`);
    check("/errors is served content-free (no secret in the payload)", !errList.text.includes(SMK) && !errList.text.includes("smoke@secret.example"), `bodyLen=${errList.text.length}`);

    // Report
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    if (fail) console.log(`FAILED: ${failed.join(" | ")}`);
  } finally {
    server.stop(true); mock.stop(true);
    await sql.end().catch(() => {});
    try { rmSync(runDir, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
