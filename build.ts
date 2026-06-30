// build.ts - compile a Bun single binary. Parameterizable for cross-compilation (P0c).
//
//  Env knobs:
//    ENTRY               entrypoint        (default ./src/index.ts)
//    OUTFILE             output binary     (default ./eunoia)
//    BUN_COMPILE_TARGET  Bun compile target, e.g. bun-linux-x64 / bun-darwin-arm64 (default: host)
//    ORT_PLATFORM        onnxruntime-node platform dir (default: process.platform)
//    ORT_ARCH            onnxruntime-node arch dir     (default: process.arch)
//
//  What it does:
//   - stubs the unused native `sharp` image dep (we are text-only)
//   - rewrites onnxruntime-node's DYNAMIC binding require into a STATIC one so Bun embeds the .node
//     (the dynamic `../bin/napi-v6/${process.platform}/${process.arch}/...` is invisible to the bundler)
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve both entrypoints to absolute paths in the SAME dir (src/) so Bun roots them consistently
// in the embedded FS — otherwise `new URL("./embed-worker.ts", import.meta.url)` won't resolve.
const ENTRY = resolve(import.meta.dir, process.env.ENTRY ?? "src/index.ts");
// The embed worker MUST be an explicit entrypoint — Bun does not auto-detect new Worker(new URL(...))
// calls for --compile (https://bun.sh/docs/bundler/executables#worker).
const WORKER = resolve(import.meta.dir, "src/embed-worker.ts");
const OUTFILE = process.env.OUTFILE ?? import.meta.dir + "/eunoia";
const TARGET = process.env.BUN_COMPILE_TARGET; // undefined -> host target
const ortPlat = process.env.ORT_PLATFORM ?? process.platform;
const ortArch = process.env.ORT_ARCH ?? process.arch;

const dynReq = "`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`";
const statReq = '"../bin/napi-v6/' + ortPlat + "/" + ortArch + '/onnxruntime_binding.node"';

// The binding's dependent shared libs for the TARGET platform (everything in its bin dir except the
// .node itself). These get embedded + extracted + preloaded at runtime (src/runtime.ts).
const ortBinDir = join(import.meta.dir, "node_modules/onnxruntime-node/bin/napi-v6", ortPlat, ortArch);
const isLib = (n: string) => /\.(so(\.\d+)*|dylib|dll)$/i.test(n);
const isPreload = (n: string) => /^libonnxruntime\.(so(\.\d+)*|.*dylib)$/i.test(n); // the main ORT lib
let ortLibNames: string[] = [];
try {
  ortLibNames = readdirSync(ortBinDir).filter(isLib);
} catch {
  console.warn("[build] no ORT bin dir for", ortPlat, ortArch, "-", ortBinDir);
}
const ortLibsModule =
  ortLibNames.map((n, i) => `import f${i} from ${JSON.stringify(join(ortBinDir, n))} with { type: "file" };`).join("\n") +
  "\nexport const ortLibFiles = [" +
  ortLibNames.map((n, i) => `{ name: ${JSON.stringify(n)}, src: f${i}, preload: ${isPreload(n)} }`).join(", ") +
  "];\n";

const compile: Record<string, unknown> = { outfile: OUTFILE };
if (TARGET) compile.target = TARGET;

const r = await Bun.build({
  entrypoints: [ENTRY, WORKER],
  compile: compile as any,
  plugins: [
    {
      name: "stub-sharp",
      setup(b) {
        b.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "stub-sharp" }));
        b.onLoad({ filter: /.*/, namespace: "stub-sharp" }, () => ({
          contents: "const f=()=>{throw new Error('sharp disabled: text-only build')};export default f;",
          loader: "js",
        }));
      },
    },
    {
      name: "ort-static-binding",
      setup(b) {
        b.onLoad({ filter: /onnxruntime-node[\/]dist[\/]binding\.js$/ }, async (args) => {
          let c = await Bun.file(args.path).text();
          c = c.replace(dynReq, statReq);
          return { contents: c, loader: "js" };
        });
      },
    },
    {
      // Virtual module exposing the TARGET's ORT dependent libs as embedded files (see src/runtime.ts).
      name: "ort-embed-libs",
      setup(b) {
        b.onResolve({ filter: /^eunoia:ort-libs$/ }, () => ({ path: "eunoia:ort-libs", namespace: "ort-libs" }));
        b.onLoad({ filter: /.*/, namespace: "ort-libs" }, () => ({ contents: ortLibsModule, loader: "js" }));
      },
    },
  ],
});
console.log("build success:", r.success, "| entry:", ENTRY, "| out:", OUTFILE, "| target:", TARGET ?? "host", "| ort:", ortPlat, ortArch);
if (!r.success) for (const m of r.logs) console.log(String(m));
