// profile.ts - profile build + injection (Spec 07).
import { Hono } from "hono";
import type { DB } from "./db";
import type { Embed } from "./embed";
import { newId, ORG_ID, DEFAULT_CONTAINER_TAG } from "./util";

type Ctx = { sql: DB; embed: Embed };
const RECENT_MEMORIES_DISPLAY_LIMIT = 10;
const BULLET = "  • ";

export type Profile = { static?: string[]; dynamic?: string[] };

export function formatProfile(p: Profile): string {
  const lines: string[] = [];
  for (const s of p.static ?? []) lines.push(BULLET + s);
  const dyn = p.dynamic ?? [];
  for (const d of dyn.slice(0, RECENT_MEMORIES_DISPLAY_LIMIT)) lines.push(BULLET + d);
  const extra = dyn.length - RECENT_MEMORIES_DISPLAY_LIMIT;
  if (extra > 0) lines.push("...and " + extra + " more recent memories");
  return lines.join("\n");
}

// Verbatim template - do not paraphrase.
export function profileContextBlock(formatted: string): string {
  return [
    "",
    "",
    "[ADDITIONAL CONTEXT - User Profile Information]",
    "The following is background information about the user to help personalize your responses. This information has been automatically collected from their previous interactions and documents:",
    "",
    formatted,
    "",
    "Note: This context is provided for personalization purposes. Use it naturally when relevant, but don't explicitly mention that you have access to this profile unless directly asked.",
  ].join("\n");
}

export async function loadProfile(sql: DB, containerTag: string): Promise<Profile> {
  const [row] = await sql`
    SELECT metadata FROM space WHERE container_tag = ${containerTag} AND org_id = ${ORG_ID} LIMIT 1`;
  return (row?.metadata?.profile as Profile) ?? { static: [], dynamic: [] };
}

export function profileRoutes({ sql }: Ctx) {
  const app = new Hono();

  app.get("/", async (c) => {
    const tag = c.req.query("containerTag") ?? DEFAULT_CONTAINER_TAG;
    return c.json(await loadProfile(sql, tag));
  });

  app.put("/", async (c) => {
    const tag = c.req.query("containerTag") ?? DEFAULT_CONTAINER_TAG;
    const profile = (await c.req.json().catch(() => ({}))) as Profile;
    await sql`
      INSERT INTO space (id, container_tag, org_id, metadata)
      VALUES (${newId()}, ${tag}, ${ORG_ID}, ${sql.json({ profile })})
      ON CONFLICT (container_tag, org_id) DO UPDATE
        SET metadata = jsonb_set(coalesce(space.metadata, '{}')::jsonb, '{profile}', ${sql.json(profile)}::jsonb),
            updated_at = now()`;
    return c.json({ ok: true });
  });

  return app;
}
