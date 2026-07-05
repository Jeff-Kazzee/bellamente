// log.ts - the single structured emitter. redact() runs here unconditionally, so no caller can log
// content by accident, and the BELLA_LOG_CONTENT escape hatch is owned here and nowhere else. Matches
// the repo convention: console.warn for failures, a bracketed subsystem tag (no console.error).
import { brandEnv } from "./env";
import { redact } from "./redact";

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v); // backstop only; redact() already returns a clean, acyclic tree
  }
}

export function logEvent(
  level: "warn" | "info",
  tag: string,
  fields: Record<string, unknown>,
  raw?: { message?: string; stack?: string },
): void {
  let line = `[${tag}] ` + safeStringify(redact(fields));
  if (raw && brandEnv("LOG_CONTENT") === "1") {
    // Local self-debug ONLY: the dev's own content, never stored, never returned to a client.
    line += " " + safeStringify({ message: raw.message, stack: raw.stack });
  }
  (level === "warn" ? console.warn : console.log)(line);
}
