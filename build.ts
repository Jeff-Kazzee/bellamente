// build.ts - compile the single binary, stubbing the unused native `sharp` image dep (text-only).
const r = await Bun.build({
  entrypoints: [import.meta.dir + "/src/index.ts"],
  compile: { outfile: import.meta.dir + "/eunoia" } as any,
  plugins: [
    {
      name: "stub-sharp",
      setup(b) {
        b.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "stub-sharp" }));
        b.onLoad({ filter: /.*/, namespace: "stub-sharp" }, () => ({
          // benign stub: only throws if actually called (image path), never on import (text path)
          contents: "const f=()=>{throw new Error('sharp disabled: text-only build')};export default f;",
          loader: "js",
        }));
      },
    },
  ],
});
console.log("success:", r.success);
if (!r.success) for (const m of r.logs) console.log(String(m));
