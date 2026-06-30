// ort-alias-preload.ts - dev (`bun run`) counterpart of build.ts's onnxruntime-node->onnxruntime-web
// alias, registered via bunfig.toml `preload`. We use transformers.js ONLY for its pure-JS tokenizer;
// aliasing keeps the native onnxruntime-node backend from loading (it would conflict with the
// onnxruntime-web instance we run inference on) in dev, matching the compiled binary.
import { plugin } from "bun";

// Defensive: the shipped binary is built with autoloadBunfig=false so it ignores a cwd bunfig.toml; but
// if this preload is ever loaded outside dev, onnxruntime-web isn't resolvable from node_modules and the
// build-time alias already applies — so no-op instead of crashing startup.
try {
  const webEntry = Bun.resolveSync("onnxruntime-web", import.meta.dir);
  plugin({
    name: "alias-ort-node-to-web",
    setup(b) {
      b.onResolve({ filter: /^onnxruntime-node(\/|$)/ }, () => ({ path: webEntry }));
    },
  });
} catch {
  /* compiled binary / no node_modules: build.ts already aliased onnxruntime-node -> onnxruntime-web */
}
