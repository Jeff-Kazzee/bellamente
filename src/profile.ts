// profile.ts - profile build + injection (Spec 07).
import { Hono } from "hono";
import type { Db } from "./db";
import type { Embed } from "./embed";

type Ctx = { db: Db; embed: Embed };
const RECENT_MEMORIES_DISPLAY_LIMIT = 10;
const BULLET = "  • ";

export type Profile = { static?: string[]; dynamic?: string[] };

export function formatProfile(p: Profile): string {
  const lines: string[] = [];
  for (const s of p.static ?? []) lines.push(BULLET + s);
  const dyn = p.dynamic ?? [];
  for (const d of dyn.slice(0, RECENT_MEMORIES_DISPLAY_LIMIT)) lines.push(BULLET + d);
  const extra = dyn.length - RECENT_MEMORIES_DISPLAY_LIMIT;
  if (extra > 0) lines.push(`...and ${extra} more recent memories`);
  return lines.join("\n");
}

// Verbatim template - do not paraphrase.
export function profileContextBlock(formatted: string): string {
  return `

[ADDITIONAL CONTEXT - User Profile Information]
The following is background information about the user to help personalize your responses. This information has been automatically collected from their previous interactions and documents:

${formatted}

Note: This context is provided for personalization purposes. Use it naturally when relevant, but don't explicitly mention that you have access to this profile unless directly asked.`;
}

export function profileRoutes({ db }: Ctx) {
  const app = new Hono();
  app.get("/", async (c) => { void db; return c.json({ static: [], dynamic: [] }); }); // TODO load
  app.put("/", async (c) => { const p = await c.req.json(); void p; return c.json({ ok: true }); }); // TODO save
  return app;
}
