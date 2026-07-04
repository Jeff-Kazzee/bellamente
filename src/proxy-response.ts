// proxy-response.ts - shared Chat Completions proxy response headers.

export type ProxyTraceHeaders = {
  traceId: string;
  contextModified: boolean;
  searchResults: number;
  latencyMs: number;
  toolIntercept?: string;
  memoryRound?: boolean;
  passthrough?: boolean;
};

type ProxyHeaderOptions = {
  streaming?: boolean;
  defaultContentType?: string;
};

export function proxyTraceHeaders(
  contentType: string | null,
  trace: ProxyTraceHeaders,
  opts: ProxyHeaderOptions = {},
) {
  const headers = new Headers();
  headers.set("content-type", contentType || opts.defaultContentType || "application/json");
  if (opts.streaming) headers.set("cache-control", "no-cache");
  headers.set("x-bella-trace-id", trace.traceId);
  headers.set("x-bella-conversation-id", trace.traceId);
  headers.set("x-bella-context-modified", String(trace.contextModified));
  headers.set("x-bella-search-results", String(trace.searchResults));
  headers.set("x-bella-search-latency-ms", String(Math.max(0, Math.round(trace.latencyMs))));
  headers.set("x-bella-memory-round", String(!!trace.memoryRound));
  if (opts.streaming) headers.set("x-bella-streaming", "true");
  if (trace.toolIntercept) headers.set("x-bella-tool-intercept", trace.toolIntercept);
  if (trace.passthrough) headers.set("x-bella-tool-passthrough", "true");
  return headers;
}

export function proxyResponse(body: string, status: number, contentType: string | null, trace: ProxyTraceHeaders) {
  return new Response(body, { status, headers: proxyTraceHeaders(contentType, trace) });
}

export function streamTraceHeaders(contentType: string | null, trace: ProxyTraceHeaders) {
  return proxyTraceHeaders(contentType, trace, { streaming: true, defaultContentType: "text/event-stream" });
}
