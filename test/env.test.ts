// env.test.ts - brand-aware env lookup: BELLA_* documented, EUNOIA_* permanent legacy alias.
import { test, expect } from "bun:test";
import { brandEnv } from "../src/env";

const cleanup = (suffix: string) => {
  delete process.env["BELLA_" + suffix];
  delete process.env["EUNOIA_" + suffix];
};

test("BELLA_ wins over EUNOIA_ when both are set", () => {
  try {
    process.env.BELLA_TEST_KNOB = "bella-value";
    process.env.EUNOIA_TEST_KNOB = "legacy-value";
    expect(brandEnv("TEST_KNOB")).toBe("bella-value");
  } finally {
    cleanup("TEST_KNOB");
  }
});

test("legacy EUNOIA_ works when BELLA_ is unset (no setup ever breaks)", () => {
  try {
    process.env.EUNOIA_TEST_KNOB = "legacy-only";
    expect(brandEnv("TEST_KNOB")).toBe("legacy-only");
  } finally {
    cleanup("TEST_KNOB");
  }
});

test("empty/whitespace values count as unset — a blank BELLA_ template line must not shadow the legacy value", () => {
  try {
    process.env.BELLA_TEST_KNOB = "   ";
    process.env.EUNOIA_TEST_KNOB = "legacy-fallback";
    expect(brandEnv("TEST_KNOB")).toBe("legacy-fallback");
    process.env.EUNOIA_TEST_KNOB = "";
    delete process.env.BELLA_TEST_KNOB;
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
    process.env.EUNOIA_UPSTREAM_TIMEOUT_MS = "9999";
    expect(upstreamTimeoutMs()).toBe(1234); // BELLA_ wins
    delete process.env.BELLA_UPSTREAM_TIMEOUT_MS;
    expect(upstreamTimeoutMs()).toBe(9999); // legacy still honored
  } finally {
    cleanup("UPSTREAM_TIMEOUT_MS");
  }
});
