// embed.ts - the embedding singleton + public surface (Spec 02).
// Local path runs the model in a WORKER thread (src/embed-worker.ts) — off the HTTP event loop and
// clear of the Bun-standalone main-thread native-ORT segfault. OpenAI dev-fallback stays inline
// (network call, no native dep). Pure model/profile helpers live in src/embed-common.ts.
import {
  EMBED_DIM,
  PROVIDER,
  LOCAL_MODEL,
  LOCAL_DTYPE,
  profile,
  truncatePayload,
  formatForTask,
  type Embed,
  type TaskType,
} from "./embed-common";

export { EMBED_DIM, isValidVector, embedModelName } from "./embed-common";
export type { Embed, TaskType } from "./embed-common";

// ---- OpenAI dev fallback (EMBEDDING_PROVIDER=openai) -----------------------------------------
async function embedOpenAI(values: string[], taskType: TaskType): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai");
  const input = truncatePayload(values).map((v) => formatForTask(v, taskType));
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small", input, dimensions: EMBED_DIM }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return json.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ---- Local worker client ---------------------------------------------------------------------
type WorkerOut = { id: number; ok: true; vectors: number[][] } | { id: number; ok: false; error: string };

function makeLocalWorkerEmbed(): Embed {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    // The worker is a separate --compile entrypoint (build.ts). Reference form differs by environment
    // (empirically verified Win+Linux compiled + dev; Bun #16869/#15981): a BARE source specifier in a
    // standalone binary, a URL-relative specifier in dev. Detect standalone via import.meta.url.
    const standalone = import.meta.url.includes("$bunfs") || /%7ebun|~bun/i.test(import.meta.url);
    const w = standalone
      ? new Worker("./embed-worker.ts", { type: "module" })
      : new Worker(new URL("./embed-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.vectors);
      else p.reject(new Error(m.error));
    };
    w.onerror = (ev: ErrorEvent) => {
      failAll(new Error("embed worker crashed: " + (ev?.message ?? "unknown")));
      worker = null; // allow a fresh worker on the next call
    };
    worker = w;
    return w;
  };

  return ({ values, taskType }) => {
    if (values.length === 0) return Promise.resolve([]);
    const w = ensureWorker();
    const id = ++seq;
    return new Promise<number[][]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, type: "embed", values, taskType });
    });
  };
}

export function makeEmbed(): Embed {
  return PROVIDER === "openai" ? ({ values, taskType }) => embedOpenAI(values, taskType) : makeLocalWorkerEmbed();
}

export async function prewarmEmbed(embed: Embed): Promise<void> {
  if (PROVIDER === "openai") return;
  if (process.env.EUNOIA_SKIP_EMBEDDING_PREWARM === "1" || process.env.EUNOIA_SKIP_EMBEDDING_PREWARM === "true") {
    console.log("[embeddings] skipping local embedding model prewarm");
    return;
  }
  console.log(`[embeddings] prewarming ${LOCAL_MODEL} (dtype=${LOCAL_DTYPE}, pooling=${profile.pooling}, dim=${EMBED_DIM}) in worker...`);
  const t = Date.now();
  await embed({ values: ["warmup"], taskType: "RETRIEVAL_DOCUMENT" });
  console.log(`[embeddings] ready in ${Date.now() - t}ms`);
}
