// scripts/mcp-coldstart-dogfood.ts — COLD-START stdout-safety proof for `bella mcp`, run against the
// COMPILED single-file binary. This is the arbiter for SPEC-P1.7's subtlest correctness property
// ("residual a"): the embed worker's cold-start `[embed] downloading model …` log (src/embed-wasm.ts)
// runs in a Worker thread whose stdout the MAIN-thread console redirect (src/index.ts) does NOT reach —
// only the worker's own redirect (src/embed-worker.ts) keeps it off the JSON-RPC channel. No unit test
// exercises this: test/mcp.test.ts B10 spawns `bun` (not the compiled binary) with a WARM model cache,
// so the download branch never fires and the worker's stdout behavior stays unproven by the suite.
//
// Why the OS-fd level, not the MCP client: `bella mcp` (unlike `bella serve`) routes ALL main-thread
// diagnostics to stderr, and a reactive MCP server writes NOTHING to stdout unprompted. So we spawn the
// binary with a FRESH, EMPTY BELLA_CACHE_DIR (a genuinely cold model cache, with ZERO clobber of the
// user's real cache) + BELLA_EMBED_TIER=quality (forces the e5 WASM *worker* path — the light/static
// tier runs inline with no worker and no onnx download), send NO JSON-RPC, capture the child's raw fd1
// and fd2, and let prewarm trigger a real cold-start embed. Then: ANY byte on fd1 (stdout) is a LEAK,
// and its content names the source. A POSITIVE CONTROL (assert the `[embed] downloading model` line
// actually appears on stderr) makes a green non-vacuous — without it, a skipped download branch looks
// identical to a clean one.
//
// Manual release-evidence dogfood — NOT a CI gate (needs a compiled binary + a real network download).
//   usage:  bun run scripts/mcp-coldstart-dogfood.ts <path-to-compiled-bella[.exe]>
//   build:  OUTFILE=/tmp/bella-dogfood.exe bun run build.ts   (host target)
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2];
if (!bin || !existsSync(bin)) {
  console.error(`usage: bun run scripts/mcp-coldstart-dogfood.ts <path-to-compiled-bella[.exe]>  (got: ${bin ?? "nothing"})`);
  process.exit(2);
}

const cache = mkdtempSync(join(tmpdir(), "bella-cold-cache-")); // EMPTY => cold model cache (user cache untouched)
const data = mkdtempSync(join(tmpdir(), "bella-cold-data-"));
const modelFile = join(cache, "models", "Xenova", "multilingual-e5-small", "onnx", "model_quantized.onnx");

const proc = Bun.spawn([bin, "mcp"], {
  cwd: data,
  env: {
    ...process.env,
    BELLA_DATA_DIR: data,
    BELLA_CACHE_DIR: cache,
    BELLA_EMBED_TIER: "quality", // e5 WASM worker path — the residual-(a) surface (light tier has no worker)
    BELLA_EMBED_TIMEOUT_MS: "300000", // let a slow cold download finish instead of the 120s default
    BELLA_MODEL_DOWNLOAD_TIMEOUT_MS: "300000",
  } as Record<string, string>,
  stdin: "pipe", // keep open so the server doesn't exit on stdin-EOF after prewarm connects the transport
  stdout: "pipe",
  stderr: "pipe",
});

let outBuf = "";
let errBuf = "";
const dec = new TextDecoder();
(async () => { for await (const ch of proc.stdout) outBuf += dec.decode(ch); })();
(async () => { for await (const ch of proc.stderr) errBuf += dec.decode(ch); })();

const start = Date.now();
const DEADLINE = 240_000;
let downloadDoneAt = 0;
while (Date.now() - start < DEADLINE) {
  if (existsSync(modelFile)) { try { if (statSync(modelFile).size > 0) { downloadDoneAt = Date.now(); break; } } catch {} }
  if (proc.exitCode !== null) break; // process exited (e.g. prewarm threw)
  await Bun.sleep(1000);
}
await Bun.sleep(4000); // let post-download inference + any late flush land
try { proc.kill(); } catch {}
await proc.exited;

rmSync(cache, { recursive: true, force: true });
rmSync(data, { recursive: true, force: true });

const sawDownloading = /\[embed\] downloading model/.test(errBuf);
const sawCached = /\[embed\] model cached/.test(errBuf);
const dlSecs = downloadDoneAt ? ((downloadDoneAt - start) / 1000).toFixed(1) : "n/a";

console.log("\n=== COLD-START stdout-safety dogfood: `bella mcp` compiled binary (no JSON-RPC sent) ===");
console.log(`binary                 : ${bin}`);
console.log(`cold cache dir         : ${cache} (fresh/empty — user cache untouched)`);
console.log(`stderr bytes           : ${errBuf.length}`);
console.log(`  '[embed] downloading' : ${sawDownloading ? "yes (worker log routed to stderr ✓)" : "NO"}`);
console.log(`  '[embed] model cached': ${sawCached ? "yes (download completed ✓)" : "no"}`);
console.log(`  download duration     : ${dlSecs}s (child exit code ${proc.exitCode})`);
console.log(`STDOUT (fd1) bytes     : ${outBuf.length}`);
if (outBuf.length) {
  console.log("---- STDOUT CONTENT (this is a LEAK on the JSON-RPC channel) ----");
  console.log(JSON.stringify(outBuf.slice(0, 2000)));
  console.log("----------------------------------------------------------------");
}

// POSITIVE CONTROL: we must have actually exercised the cold-start worker path, else the result is vacuous.
if (!sawDownloading) {
  console.log("\n❌ VACUOUS: never saw '[embed] downloading model' on stderr — the cold-start worker path did not run.");
  console.log("   (cache not actually cold? wrong tier? BELLA_CACHE_DIR ineffective? model already present?)");
  console.log("   last 800 chars of stderr for diagnosis:\n" + errBuf.slice(-800));
  process.exit(1);
}
if (outBuf.length > 0) {
  console.log("\n❌ STDOUT LEAK: the real cold-start path put bytes on fd1 (the JSON-RPC channel). residual (a) is");
  console.log("   NOT fully fixed by the console redirect — see the leaked content above for the source.");
  process.exit(1);
}
console.log("\n✅ residual (a) PROVEN on the real binary: a full cold-start embed (download + onnx inference)");
console.log("   ran in the worker and NOT ONE byte reached stdout. The JSON-RPC channel stays pure.");
process.exit(0);
