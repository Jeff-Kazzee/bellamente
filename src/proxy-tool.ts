// proxy-tool.ts - Chat Completions tool-call primitives shared by proxy modes.
import { newId } from "./util";

export const MIN_QUERIES_PER_CALL = 1;
export const MAX_QUERIES_PER_CALL = 5;

export type MemoryToolCall = {
  id: string;
  queries: string[];
};

export function parseToolArgs(value: unknown): string[] {
  let parsed: any = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "{}");
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed?.queries)
    ? parsed.queries
        .filter((q: unknown): q is string => typeof q === "string")
        .map((q: string) => q.trim())
        .filter(Boolean)
    : [];
}

export function isNamedToolCall(call: any, name: string): boolean {
  return (!call?.type || call.type === "function") && call?.function?.name === name;
}

export function memoryToolCallFromChatCall(call: any): MemoryToolCall {
  return { id: String(call.id || newId()), queries: parseToolArgs(call.function.arguments) };
}
