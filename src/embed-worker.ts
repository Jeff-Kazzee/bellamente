// embed-worker.ts - runs the WASM embedding engine (src/embed-wasm.ts) OFF the main thread, so model
// inference never blocks the HTTP loop. No native code involved.
//
// Protocol (structured-clone over postMessage):
//   in : { id: number, type: "embed", values: string[], taskType: TaskType }
//   out: { id: number, ok: true, vectors: number[][] } | { id: number, ok: false, error: string }
import { embedWasm } from "./embed-wasm";
import type { TaskType } from "./embed-common";

// CRITICAL (SPEC-P1.7): under `bella mcp`, stdout is the JSON-RPC channel and this worker shares the
// parent's stdout. The main-thread redirect in index.ts does NOT cross the Worker boundary, so the
// cold-start model-download logs in embed-wasm.ts (console.log, first run only) would corrupt the
// protocol. Route this worker's console diagnostics to stderr for its lifetime. Safe in every parent
// context — this worker's only legitimate output is postMessage, so nothing real uses stdout. (Do NOT
// redirect process.stdout.write here without proving worker/parent stdout isolation first.)
console.log = console.error;
console.info = console.error;
console.debug = console.error;

type InMsg = { id: number; type: "embed"; values: string[]; taskType: TaskType };
type OutMsg = { id: number; ok: true; vectors: number[][] } | { id: number; ok: false; error: string };

declare const self: { onmessage: ((ev: MessageEvent<InMsg>) => void) | null; postMessage: (m: OutMsg) => void };

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const m = ev.data;
  if (m.type !== "embed") return;
  try {
    const vectors = await embedWasm(m.values, m.taskType);
    self.postMessage({ id: m.id, ok: true, vectors });
  } catch (e: any) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message ?? e) });
  }
};
