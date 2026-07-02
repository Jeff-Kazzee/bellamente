// env.test.ts - brand-aware env lookup: BELLA_* is the only spelling (legacy alias removed pre-release).
import { test, expect } from "bun:test";
import { brandEnv } from "../src/env";

const cleanup = (suffix: string) => {
  delete process.env["BELLA_" + suffix];
};

test("BELLA_ is read", () => {
  try {
    process.env.BELLA_TEST_KNOB = "bella-value";
    expect(brandEnv("TEST_KNOB")).toBe("bella-value");
  } finally {
    cleanup("TEST_KNOB");
  }
});

test("empty/whitespace values count as unset — a blank BELLA_ template line must not shadow the default", () => {
  try {
    process.env.BELLA_TEST_KNOB = "   ";
    expect(brandEnv("TEST_KNOB")).toBeUndefined();
    process.env.BELLA_TEST_KNOB = "";
    expect(brandEnv("TEST_KNOB")).toBeUndefined();
  } finally {
    cleanup("TEST_KNOB");
  }
});

// End-to-end proof that BELLA_ reaches a real consumer: the proxy timeout knob.
test("BELLA_UPSTREAM_TIMEOUT_MS drives the proxy deadline", async () => {
  const { upstreamTimeoutMs } = await import("../src/proxy");
  try {
    process.env.BELLA_UPSTREAM_TIMEOUT_MS = "1234";
    expect(upstreamTimeoutMs()).toBe(1234);
    delete process.env.BELLA_UPSTREAM_TIMEOUT_MS;
    expect(upstreamTimeoutMs()).toBe(120_000); // documented default
  } finally {
    cleanup("UPSTREAM_TIMEOUT_MS");
  }
});
