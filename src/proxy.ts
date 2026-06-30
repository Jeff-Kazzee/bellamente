// proxy.ts - OpenAI-compatible interceptor (Spec 06, port of Cs6).
import { Hono } from "hono";
import type { Db } from "./db";
import type { Embed } from "./embed";
import { searchMemories, Q } from "./search";
import { formatProfile, profileContextBlock, type Profile } from "./profile";

type Ctx = { db: Db; embed: Embed };

export const SUPERMEMORY_TOOL_NAME = "supermemoryToolSearch";
export const MIN_QUERIES_PER_CALL = 1;
export const MAX_QUERIES_PER_CALL = 5;

// Verbatim tool definition (must match exactly).
export function toolDescription() {
  return {
    name: SUPERMEMORY_TOOL_NAME,
    description:
      "***CRITICAL: YOU CAN ONLY MAKE ONE TOOL CALL*** - Search through the user's personal memories, documents, and stored information when you need specific context that isn't already available. You can include MULTIPLE search queries in a SINGLE tool call. Do NOT make multiple separate tool calls - include all your queries in the queries array in ONE call. Use this when the user asks about their personal information, past conversations, documents they've saved, or when you need more context to provide a helpful response.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of search queries to find relevant information. Include ALL queries you want to search in this single array - you cannot make multiple tool calls.",
          minItems: MIN_QUERIES_PER_CALL,
          maxItems: MAX_QUERIES_PER_CALL,
        },
      },
      required: ["queries"],
    },
  };
}

export function proxyRoutes(ctx: Ctx) {
  const app = new Hono();

  // POST /v1/chat/completions
  app.post("/chat/completions", async (c) => {
    const userId =
      c.req.header("x-sm-user-id") ||
      new URL(c.req.url).searchParams.get("userId") ||
      undefined;
    const body = await c.req.json();

    // 1. passthrough if request already carries tool_result content
    const hasToolResults = (body.messages ?? []).some((m: any) =>
      Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_result"),
    );
    if (hasToolResults) {
      c.header("x-supermemory-tool-passthrough", "true");
      c.header("x-supermemory-context-modified", "false");
      // TODO: forward upstream unmodified, return its response.
      return c.json({ note: "passthrough (not wired)" });
    }

    // 2. inject tool
    body.tools = body.tools ?? [];
    if (!body.tools.some((t: any) => t.name === SUPERMEMORY_TOOL_NAME)) {
      body.tools.unshift(toolDescription());
    }

    // 3. inject profile (TODO load real profile for userId)
    const profile: Profile = { static: [], dynamic: [] };
    const block = profileContextBlock(formatProfile(profile));
    if (typeof body.system === "string") body.system += block;
    else if (body.system && typeof body.system === "object" && "content" in body.system)
      body.system.content += block;
    else body.system = block.trim();

    // 4. forward upstream; 5. intercept tool_calls; 6. run search; 7. re-invoke. (TODO)
    void userId; void ctx; void searchMemories; void Q;
    c.header("x-supermemory-tool-intercept", SUPERMEMORY_TOOL_NAME);
    return c.json({ note: "proxy core not wired - tool injected, upstream forward is TODO" });
  });

  return app;
}
