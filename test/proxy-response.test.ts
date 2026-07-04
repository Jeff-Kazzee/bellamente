import { expect, test } from "bun:test";
import { proxyResponse, streamTraceHeaders } from "../src/proxy-response";

const trace = {
  traceId: "trace-1",
  contextModified: true,
  searchResults: 3,
  latencyMs: 12.4,
  toolIntercept: "searchMemory",
};

test("proxyResponse preserves buffered header contract and omits streaming-only headers", async () => {
  const res = proxyResponse("{}", 202, null, trace);

  expect(res.status).toBe(202);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("x-bella-trace-id")).toBe("trace-1");
  expect(res.headers.get("x-bella-conversation-id")).toBe("trace-1");
  expect(res.headers.get("x-bella-context-modified")).toBe("true");
  expect(res.headers.get("x-bella-search-results")).toBe("3");
  expect(res.headers.get("x-bella-search-latency-ms")).toBe("12");
  expect(res.headers.get("x-bella-memory-round")).toBe("false");
  expect(res.headers.get("x-bella-tool-intercept")).toBe("searchMemory");
  expect(res.headers.has("x-bella-streaming")).toBe(false);
  expect(res.headers.has("cache-control")).toBe(false);
});

test("streamTraceHeaders preserves streaming-only response markers", () => {
  const headers = streamTraceHeaders(null, { ...trace, memoryRound: true, passthrough: true });

  expect(headers.get("content-type")).toBe("text/event-stream");
  expect(headers.get("cache-control")).toBe("no-cache");
  expect(headers.get("x-bella-streaming")).toBe("true");
  expect(headers.get("x-bella-memory-round")).toBe("true");
  expect(headers.get("x-bella-tool-passthrough")).toBe("true");
});
