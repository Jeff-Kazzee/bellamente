// Dashboard wiring: the shell is served publicly (a browser can't send a bearer header on navigation), the
// API stays bearer-authed, and the served HTML carries no secret. Uses buildApp with a stub ctx (no real DB).
import { test, expect } from "bun:test";

process.env.BELLA_API_KEY = "test-key-123"; // must be set before importing index (EXPECTED_AUTH is import-time)
const { buildApp } = await import("../src/index");

// porsager-shaped stub: a tagged-template `sql` that resolves to [] — enough for GET /inspect -> {traces:[]}.
const sql: any = Object.assign((..._a: any[]) => Promise.resolve([]), {
  json: (x: any) => x,
  begin: async (f: any) => f(sql),
  unsafe: async () => [],
  end: async () => {},
});
const app = buildApp({ sql, embed: (async () => []) as any });
const req = (path: string, init?: RequestInit) => app.request(path, init);
const AUTH = { authorization: "Bearer test-key-123" };

test("GET / serves the dashboard shell publicly (no key needed) and leaks no secret", async () => {
  const r = await req("/");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type") || "").toContain("text/html");
  const html = await r.text();
  expect(html).toContain("Bellamente"); // the brand, everywhere
  expect(html).toContain("Recall traces"); // trace-as-hero copy
  expect(html).toContain('id="app"');
  expect(html).not.toContain("onnxruntime"); // WASM-clean: no ONNX markers in the shipped UI
  expect(html).not.toContain("test-key-123"); // the shell must never embed the API key
});

test("GET / ships a restrictive Content-Security-Policy", async () => {
  const r = await req("/");
  const csp = r.headers.get("content-security-policy") || "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'"); // same-origin API calls only — no exfil targets
  expect(csp).toContain("frame-ancestors 'none'");
});

test("GET /health is public and identifies the service (stable tag) + brand", async () => {
  const r = await req("/health");
  expect(r.status).toBe(200);
  // service:"bellamente" is the doctor's authenticity contract;
  // brand carries the public name.
  expect(await r.json()).toMatchObject({ ok: true, service: "bellamente", brand: "bellamente" });
});

test("API routes require the bearer key", async () => {
  expect((await req("/inspect")).status).toBe(401);
  expect((await req("/inspect", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await req("/memories")).status).toBe(401);
});

test("API routes pass the gate with the correct key", async () => {
  const r = await req("/inspect", { headers: AUTH });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ traces: [] });
});
