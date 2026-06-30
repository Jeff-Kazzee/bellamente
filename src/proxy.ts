// proxy.ts - OpenAI-compatible interceptor. Injects a memory-search tool + user context.
// (Clean-room: our own tool name, header names, and wording.)
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { searchMemories, Q } from "./search";
import { formatProfile, profileContextBlock, loadProfile } from "./profile";
import { DEFAULT_CONTAINER_TAG } from "./util";

type Ctx = { sql: DB; embed: Embed };

export const MEMORY_TOOL_NAME = "searchMemory";
export const MIN_QUERIES_PER_CALL = 1;
export const MAX_QUERIES_PER_CALL = 5;

// Our own tool definition (functionally: one call per turn, batch queries into the array).
export function toolDescription() {
  return {
    name: MEMORY_TOOL_NAME,
    description:
      "Look up the user's saved memories and documents whenever you need context you do not already have - their preferences, facts about them, earlier conversations, or material they have stored. Call this at most once per turn: put every question you want answered into the `queries` array in a single call instead of invoking the tool repeatedly.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "One or more search phrases to look up. Include every query you need here, because the tool runs only once per turn.",
          minItems: MIN_QUERIES_PER_CALL,
          maxItems: MAX_QUERIES_PER_CALL,
        },
      },
      required: ["queries"],
    },
  };
}

// Run up to MAX_QUERIES_PER_CALL searches, merge by id keep max similarity, cap MAX_COMBINED_RESULTS.
export async function runToolSearch(ctx: Ctx, queries: string[]) {
  const capped = queries.slice(0, MAX_QUERIES_PER_CALL);
  const batches = await Promise.all(capped.map((q) => searchMemories(ctx, { q })));
  const merged = new Map<string, { id: string; memory: string; similarity: number }>();
  for (const batch of batches) {
    for (const r of batch) {
      const prev = merged.get(r.id);
      if (!prev || r.similarity > prev.similarity) merged.set(r.id, r);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Q.MAX_COMBINED_RESULTS);
}

export function proxyRoutes(ctx: Ctx) {
  const app = new Hono();

  // POST /v1/chat/completions
  app.post("/chat/completions", async (c) => {
    const userId =
      c.req.header("x-minimem-user-id") || new URL(c.req.url).searchParams.get("userId") || undefined;
    const body = await c.req.json().catch(() => ({}));

    // 1. passthrough if request already carries tool_result content
    const hasToolResults = (body.messages ?? []).some(
      (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_result"),
    );
    if (hasToolResults) {
      c.header("x-minimem-tool-passthrough", "true");
      c.header("x-minimem-context-modified", "false");
      return c.json({ note: "passthrough mode (upstream forward not wired - M3)" });
    }

    // 2. inject tool
    body.tools = body.tools ?? [];
    if (!body.tools.some((t: any) => t.name === MEMORY_TOOL_NAME)) {
      body.tools.unshift(toolDescription());
    }

    // 3. inject profile
    const profile = await loadProfile(ctx.sql, DEFAULT_CONTAINER_TAG);
    const block = profileContextBlock(formatProfile(profile));
    if (typeof body.system === "string") body.system += block;
    else if (body.system && typeof body.system === "object" && "content" in body.system)
      body.system.content += block;
    else body.system = block.trim();

    // 4-7. forward upstream, intercept tool_calls, runToolSearch, re-invoke. TODO (M3).
    void userId;
    c.header("x-minimem-tool-intercept", MEMORY_TOOL_NAME);
    return c.json({ note: "proxy core not wired (M3): tool + profile injected; upstream forward TODO" });
  });

  return app;
}
