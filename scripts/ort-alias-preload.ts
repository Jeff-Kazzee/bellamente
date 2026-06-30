// ort-alias-preload.ts - dev (`bun run`) counterpart of build.ts's onnxruntime-node->onnxruntime-web
// alias. Registered via bunfig.toml `preload`. Ensures transformers.js (tokenizer) and our inference
// share the SAME single onnxruntime-web instance — no native onnxruntime-node, no two-runtime conflict.
import { plugin } from "bun";

// Defensive: in a compiled binary (which also reads a cwd bunfig.toml) onnxruntime-web isn't resolvable
// from node_modules and the build-time alias already applies — so no-op instead of crashing startup.
try {
  const webEntry = Bun.resolveSync("onnxruntime-web", import.meta.dir);
  plugin({
    name: "alias-ort-node-to-web",
    setup(b) {
      b.onResolve({ filter: /^onnxruntime-node$/ }, () => ({ path: webEntry }));
    },
  });
} catch {
  /* compiled binary / no node_modules: build.ts already aliased onnxruntime-node -> onnxruntime-web */
}
