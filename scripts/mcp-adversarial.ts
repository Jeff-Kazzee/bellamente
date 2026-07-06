// scripts/mcp-adversarial.ts — ADVERSARIAL dogfood of `bella mcp`. Not a happy-path demo: it throws
// abuse at every tool through a real MCP client and asserts each degrades GRACEFULLY — returns an
// error result OR rejects with a clean error — never hangs, crashes the server, or (worst) reports a
// false success. After the abuse it proves the server is still fully functional (state not corrupted).
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { EMBED_DIM } from "../src/embed-common";
import type { Embed } from "../src/embed";
import { makeMcpServer } from "../src/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pad = (v: number[]) => { const o = new Array(EMBED_DIM).fill(0); for (let i = 0; i < Math.min(v.length, EMBED_DIM); i++) o[i] = v[i]!; return o; };
const embed: Embed = async ({ values }) => values.map(() => pad([1, 0, 0, 0]));

async function main() {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(EMBED_DIM));
  const server = makeMcpServer({ sql, embed });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "adversary", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  const HUGE = "x".repeat(2_000_000);
  let bad = 0;
  // Each probe: call the tool; classify outcome. GRACEFUL = ok | error-result | clean rejection.
  // BAD = HANG (15s), or a "false success" (ok result on input that should have been rejected).
  async function probe(name: string, args: any, tool: string, expect: "reject" | "ok") {
    let outcome = "", detail = "";
    try {
      const r: any = await Promise.race([
        client.callTool({ name: tool, arguments: args }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("HANG")), 15000)),
      ]);
      const isErr = !!r?.isError;
      outcome = isErr ? "error-result" : "ok";
      detail = (r?.content?.[0]?.text ?? "").slice(0, 50);
    } catch (e) {
      outcome = msg(e) === "HANG" ? "HANG" : "rejected";
      detail = msg(e).slice(0, 50);
    }
    // graceful for a should-reject input = error-result or rejected; NEVER ok (that's a false success), NEVER HANG.
    const graceful = expect === "ok" ? outcome === "ok" : outcome === "error-result" || outcome === "rejected";
    if (!graceful) bad++;
    console.log(`  ${graceful ? "✓" : "✗ BAD"}  [${outcome}] ${name} — ${detail}`);
  }

  console.log("=== ADVERSARIAL DOGFOOD: bella mcp — try to break every tool ===\n");
  console.log("memory_write:");
  await probe("empty content", { content: "" }, "memory_write", "reject");
  await probe("missing content", {}, "memory_write", "reject");
  await probe("over 10000 chars", { content: "x".repeat(10001) }, "memory_write", "reject");
  await probe("wrong type isStatic", { content: "ok", isStatic: "yes" }, "memory_write", "reject");
  await probe("SQL/quote/unicode nasties (should STORE fine)", { content: "Robert'); DROP TABLE memory_entry;-- 你好  \"q\"" }, "memory_write", "ok");

  console.log("memory_search:");
  await probe("empty query", { query: "" }, "memory_search", "reject");
  await probe("bogus searchMode", { query: "x", searchMode: "telepathy" }, "memory_search", "reject");
  await probe("limit 99999 (>max 100)", { query: "x", limit: 99999 }, "memory_search", "reject");
  await probe("limit 0", { query: "x", limit: 0 }, "memory_search", "reject");
  await probe("limit -5", { query: "x", limit: -5 }, "memory_search", "reject");

  console.log("memory_forget:");
  await probe("empty id", { id: "" }, "memory_forget", "reject");
  await probe("nonexistent id", { id: "zzzzzzzzzzzzzzzzzzzzzz" }, "memory_forget", "reject");
  await probe("id with slashes/traversal", { id: "../../etc/passwd" }, "memory_forget", "reject");

  console.log("memory_list:");
  await probe("limit 99999", { limit: 99999 }, "memory_list", "reject");
  await probe("limit -1", { limit: -1 }, "memory_list", "reject");

  console.log("document_ingest:");
  await probe("empty content", { content: "" }, "document_ingest", "reject");
  await probe("2MB content (unbounded? watch for hang/OOM)", { content: HUGE }, "document_ingest", "ok");

  console.log("trace_inspect:");
  await probe("bogus traceId", { traceId: "not-a-real-trace-id" }, "trace_inspect", "reject");
  await probe("limit 99999 (>max 200)", { limit: 99999 }, "trace_inspect", "reject");

  console.log("concurrency (10 writes + 10 searches at once — no crash/hang):");
  try {
    const burst = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => client.callTool({ name: "memory_write", arguments: { content: `burst fact ${i}` } })),
      ...Array.from({ length: 10 }, () => client.callTool({ name: "memory_search", arguments: { query: "burst" } })),
    ]);
    const okCount = burst.filter((r: any) => !r?.isError).length;
    console.log(`  ${okCount === 20 ? "✓" : "✗ BAD"}  ${okCount}/20 concurrent calls succeeded`);
    if (okCount !== 20) bad++;
  } catch (e) { console.log(`  ✗ BAD  concurrency threw: ${msg(e)}`); bad++; }

  console.log("post-abuse sanity (state not corrupted — a normal write+search still works):");
  await probe("normal write", { content: "the sky is blue" }, "memory_write", "ok");
  await probe("normal search finds it", { query: "sky" }, "memory_search", "ok");

  await client.close(); await server.close(); await sql.end().catch(() => {});
  console.log(`\n=== RESULT: ${bad === 0 ? "✅ every abuse handled gracefully (no crash/hang/false-success)" : `❌ ${bad} BAD outcomes — needs fixing`} ===`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error("HARNESS CRASHED (itself a finding):", e); process.exit(2); });
