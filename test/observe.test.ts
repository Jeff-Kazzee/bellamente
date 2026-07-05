// observe.test.ts - the wiring, end to end. Proves the two capture seams added to production code:
//  (1) app.onError turns an unhandled throw into a structured JSON 500 (was Hono's bare text) with a
//      correlation traceId and NO leaked error content;
//  (2) the proxy memory-tool degrade (swallow-to-empty) now flows through capture() instead of failing
//      silently, still content-free.
import { test, expect } from "bun:test";
import { buildApp } from "../src/index";
import { runMemoryToolRound } from "../src/proxy-tool-round";
import { makeCtx, TEST_TIMEOUT_MS } from "./proxy-fixture";
import type { Embed } from "../src/embed";
import type { AuthConfig } from "../src/auth";

const NO_AUTH: AuthConfig = { required: false, key: null, source: "none" };

async function collect(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const priorWarn = console.warn;
  const priorLog = console.log;
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = priorWarn;
    console.log = priorLog;
  }
  return lines.join("\n");
}

test(
  "app.onError returns a structured JSON 500 with a traceId and never leaks the error message",
  async () => {
    const SECRET = "ONERRORSECRET_z7";
    const throwingEmbed: Embed = async () => {
      throw new Error(SECRET);
    };
    const { sql, close } = await makeCtx({ embed: throwingEmbed });
    try {
      const app = buildApp({ sql, embed: throwingEmbed }, NO_AUTH);
      let res: Response | undefined;
      const logged = await collect(async () => {
        res = await app.request("/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: "hello" }),
        });
      });

      expect(res!.status).toBe(500);
      expect(res!.headers.get("content-type") || "").toContain("application/json"); // JSON, not bare text
      const body = (await res!.json()) as { error: string; code: string; traceId: string };
      expect(body.error).toBe("Internal error"); // safe userFacing string, not the raw message
      expect(typeof body.code).toBe("string");
      expect(body.traceId).toHaveLength(22);

      // The secret rode in on the Error message; it must not appear in the body or the capture log.
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(logged).not.toContain(SECRET);
      expect(logged).toContain("[observe]"); // the failure WAS captured (not silent)
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "proxy memory-tool degrade captures the swallowed failure content-free",
  async () => {
    const SECRET = "PROXYSECRET_q9";
    const throwingEmbed: Embed = async () => {
      throw new Error(SECRET);
    };
    const { sql, close } = await makeCtx({ embed: throwingEmbed });
    try {
      let round: Awaited<ReturnType<typeof runMemoryToolRound>> | undefined;
      const logged = await collect(async () => {
        round = await runMemoryToolRound(
          { sql, embed: throwingEmbed },
          [{ id: "call1", queries: ["q1"] }],
          {},
        );
      });

      // Degradation semantics preserved: failure -> empty results, flagged.
      expect(round!.toolSearchFailed).toBe(true);
      expect(round!.allBatches.length).toBe(0);

      // But it is no longer silent, and no user content leaked.
      expect(logged).toContain("[observe]");
      expect(logged).toContain("TOOL_SEARCH_FAILED");
      expect(logged).not.toContain(SECRET);
    } finally {
      await close();
    }
  },
  TEST_TIMEOUT_MS,
);
