// embed-worker.ts - runs the transformers.js / ONNX model OFF the main thread.
// This is Supermemory's pattern (a worker pool) and it is also our fix for the Bun-standalone
// main-thread native-ORT segfault: the heavy native addon loads + runs here, not on the HTTP loop.
//
// Protocol (structured-clone over postMessage):
//   in : { id: number, type: "embed", values: string[], taskType: TaskType }
//   out: { id: number, ok: true, vectors: number[][] } | { id: number, ok: false, error: string }
import { LOCAL_MODEL, LOCAL_DTYPE, profile, formatForTask, truncatePayload, mrl, EMBED_DIM, type TaskType } from "./embed-common";

// P0b will extract embedded ORT native libs to runtimeDir() + set the loader search path BEFORE the
// first transformers.js import below pulls in onnxruntime-node. Done here (in the worker, pre-import).
import { prepareNativeRuntime } from "./runtime";

type InMsg = { id: number; type: "embed"; values: string[]; taskType: TaskType };
type OutMsg = { id: number; ok: true; vectors: number[][] } | { id: number; ok: false; error: string };

let pipePromise: Promise<(input: string[], opts: any) => Promise<{ tolist: () => number[][] }>> | null = null;
async function getLocalPipe() {
  if (!pipePromise) {
    pipePromise = (async () => {
      prepareNativeRuntime();
      const { pipeline, env } = await import("@huggingface/transformers");
      const { modelsDir } = await import("./paths");
      // Safe, writable model cache under the per-user app-data dir (see src/paths.ts).
      env.cacheDir = process.env.EUNOIA_MODEL_DIR ?? modelsDir();
      return (await pipeline("feature-extraction", LOCAL_MODEL, { dtype: LOCAL_DTYPE })) as any;
    })();
  }
  return pipePromise;
}

async function embedLocal(values: string[], taskType: TaskType): Promise<number[][]> {
  const input = truncatePayload(values).map((v) => formatForTask(v, taskType));
  const pipe = await getLocalPipe();
  const out = await pipe(input, { pooling: profile.pooling, normalize: false });
  return out.tolist().map((v) => mrl(v, EMBED_DIM));
}

declare const self: { onmessage: ((ev: MessageEvent<InMsg>) => void) | null; postMessage: (m: OutMsg) => void };

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const m = ev.data;
  if (m.type !== "embed") return;
  try {
    const vectors = await embedLocal(m.values, m.taskType);
    self.postMessage({ id: m.id, ok: true, vectors });
  } catch (e: any) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message ?? e) });
  }
};
