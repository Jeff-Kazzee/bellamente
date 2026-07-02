// embed.ts - the embedding singleton + public surface (Spec 02).
// Local path runs the WASM embedding engine in a WORKER thread (src/embed-worker.ts) — keeping model
// inference off the HTTP event loop. OpenAI dev-fallback stays inline (network call). Pure model/profile
// helpers live in src/embed-common.ts.
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
import { brandEnv } from "./env";

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

type Pending = { resolve: (v: number[][]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const EMBED_TIMEOUT_MS = Number(brandEnv("EMBED_TIMEOUT_MS") ?? 120_000);

function makeLocalWorkerEmbed(): Embed {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();

  // Tear down the (hung/crashed) worker and reject every in-flight request so the next call respawns.
  const recycle = (err: Error) => {
    const dead = worker;
    worker = null;
    if (dead) { try { dead.terminate(); } catch {} }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
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
      if (w !== worker) return; // ignore late messages from a replaced worker
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.vectors);
      else p.reject(new Error(m.error));
    };
    w.onerror = (ev: ErrorEvent) => {
      if (w !== worker) return; // ignore late errors from a replaced worker
      recycle(new Error("embed worker crashed: " + (ev?.message ?? "unknown")));
    };
    worker = w;
    return w;
  };

  return ({ values, taskType }) => {
    if (values.length === 0) return Promise.resolve([]);
    const w = ensureWorker();
    const id = ++seq;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A hung worker won't serve anyone — recycle it so the next request gets a fresh one.
        if (pending.has(id)) recycle(new Error(`embed worker timed out after ${EMBED_TIMEOUT_MS}ms`));
      }, EMBED_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, type: "embed", values, taskType });
    });
  };
}

export function makeEmbed(): Embed {
  if (PROVIDER === "openai") return ({ values, taskType }) => embedOpenAI(values, taskType);
  if (profile.engine === "static") return makeStaticEmbed();
  return makeLocalWorkerEmbed();
}

// Static Model2Vec ("potion") runs INLINE — pure-TS, low-RAM, no worker and no native/WASM, so it cannot
// hang (the multi-thread WASM failure) or OOM-crash. Loaded lazily on first use.
function makeStaticEmbed(): Embed {
  return async ({ values, taskType }) => {
    if (values.length === 0) return [];
    const { embedStatic } = await import("./embed-model2vec");
    return embedStatic(values, taskType);
  };
}

export async function prewarmEmbed(embed: Embed): Promise<void> {
  if (PROVIDER === "openai") return;
  const skip = brandEnv("SKIP_EMBEDDING_PREWARM");
  if (skip === "1" || skip === "true") {
    console.log("[embeddings] skipping local embedding model prewarm");
    return;
  }
  const where = profile.engine === "static" ? "static/inline" : `wasm/worker dtype=${LOCAL_DTYPE}`;
  console.log(`[embeddings] prewarming ${LOCAL_MODEL} (${where}, pooling=${profile.pooling}, dim=${EMBED_DIM})...`);
  const t = Date.now();
  await embed({ values: ["warmup"], taskType: "RETRIEVAL_DOCUMENT" });
  console.log(`[embeddings] ready in ${Date.now() - t}ms`);
}
