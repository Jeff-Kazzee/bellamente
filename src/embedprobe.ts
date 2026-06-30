// embedprobe.ts - standalone native-ORT probe (lives in src/ so it co-locates with embed-worker.ts,
// mirroring the real index.ts layout for faithful worker-resolution testing). Compiled to a Bun
// single binary to test the embedding runtime in ISOLATION from DB/HTTP (P0c validation).
//   PROBE_MODE=main   -> embed on the MAIN thread (isolates the standalone native-ORT segfault test)
//   PROBE_MODE=worker -> (default) embed via the worker thread (the production path)
import { prepareNativeRuntime } from "./runtime";

async function mainThreadEmbed(): Promise<number[]> {
  await prepareNativeRuntime();
  const { pipeline, env } = await import("@huggingface/transformers");
  const { modelsDir } = await import("./paths");
  env.cacheDir = process.env.EUNOIA_MODEL_DIR ?? modelsDir();
  const model = process.env.LOCAL_EMBED_MODEL ?? "Xenova/multilingual-e5-small";
  const pipe: any = await pipeline("feature-extraction", model, { dtype: (process.env.LOCAL_EMBED_DTYPE ?? "q8") as any });
  const out = await pipe(["query: hello world"], { pooling: "mean", normalize: true });
  return out.tolist()[0];
}

async function workerEmbed(): Promise<number[]> {
  const { makeEmbed } = await import("./embed");
  const [v] = await makeEmbed()({ values: ["hello world"], taskType: "RETRIEVAL_DOCUMENT" });
  return v!;
}

const mode = process.env.PROBE_MODE ?? "worker";
console.log("[probe] start mode=" + mode + " platform=" + process.platform + " arch=" + process.arch);
try {
  const v = mode === "main" ? await mainThreadEmbed() : await workerEmbed();
  const ok = Array.isArray(v) && v.length > 0 && v.every((x) => Number.isFinite(x));
  console.log("[probe] " + (ok ? "OK" : "BAD-VECTOR") + " mode=" + mode + " dim=" + (v?.length ?? 0) + " first3=" + JSON.stringify(v?.slice(0, 3)));
  process.exit(ok ? 0 : 2);
} catch (e: any) {
  console.error("[probe] FAIL mode=" + mode + " err=" + (e?.stack ?? e));
  process.exit(1);
}
