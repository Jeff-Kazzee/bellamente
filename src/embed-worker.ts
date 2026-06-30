// embed-worker.ts - runs the WASM embedding engine (src/embed-wasm.ts) OFF the main thread, so model
// inference never blocks the HTTP loop. No native code involved.
//
// Protocol (structured-clone over postMessage):
//   in : { id: number, type: "embed", values: string[], taskType: TaskType }
//   out: { id: number, ok: true, vectors: number[][] } | { id: number, ok: false, error: string }
import { embedWasm } from "./embed-wasm";
import type { TaskType } from "./embed-common";

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
