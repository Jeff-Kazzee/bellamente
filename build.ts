// build.ts - compile the single binary.
//  - stub the unused native `sharp` image dep (we are text-only)
//  - rewrite onnxruntime-node's DYNAMIC binding require into a STATIC one so Bun embeds the .node
//    (the dynamic `../bin/napi-v6/${process.platform}/${process.arch}/...` is invisible to the bundler).
const ortPlat = process.env.ORT_PLATFORM ?? process.platform;
const ortArch = process.env.ORT_ARCH ?? process.arch;
const dynReq = "`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`";
const statReq = '"../bin/napi-v6/' + ortPlat + "/" + ortArch + '/onnxruntime_binding.node"';

const r = await Bun.build({
  entrypoints: [import.meta.dir + "/src/index.ts"],
  compile: { outfile: import.meta.dir + "/eunoia" } as any,
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
  ],
});
console.log("build success:", r.success, "| ort target:", ortPlat, ortArch);
if (!r.success) for (const m of r.logs) console.log(String(m));
