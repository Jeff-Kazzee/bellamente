// proxy-request.ts - Chat Completions request-shape helpers for proxy tracing and context injection.

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as any).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// The proxy speaks Chat Completions ONLY. Anthropic support is a BACKLOG decision, not an accident
// of parsing top-level `system` or content blocks that the proxy cannot round-trip.
export function promptText(body: any): string | undefined {
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    const text = contentText(m?.content);
    if (text) parts.push(`${m?.role ?? "message"}: ${text}`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

export function requestSummary(body: any) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return {
    model: typeof body.model === "string" ? body.model : null,
    messageCount: messages.length,
    toolCount: tools.length,
    hasSystem: messages.some((m: any) => m?.role === "system"),
    stream: body.stream === true,
  };
}

export function hasToolResults(body: any): boolean {
  return (body.messages ?? []).some((m: any) => m?.role === "tool");
}
