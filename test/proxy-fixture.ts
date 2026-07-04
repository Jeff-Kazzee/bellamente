import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { makePgliteSql, type Sql } from "../src/pg-shim";
import { schemaForDim } from "../src/db";
import { ORG_ID, DEFAULT_CONTAINER_TAG } from "../src/util";
import type { Embed } from "../src/embed";

export const memId = "m".repeat(22);
export const spaceId = "s".repeat(22);
const userVector = "[1,0,0,0]";
export const TEST_TIMEOUT_MS = 15000;
export const encoder = new TextEncoder();

export function sseResponse(chunks: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

type TestCtxOpts = {
  fetch?: typeof fetch;
  upstreamBaseUrl?: string;
  allowUnauthenticatedUpstream?: boolean;
  embed?: Embed;
};

export async function makeCtx(opts: TestCtxOpts = {}) {
  const pg = await PGlite.create({ dataDir: "memory://", extensions: { vector } });
  const sql = makePgliteSql(pg);
  await sql.unsafe(schemaForDim(4));
  const embed: Embed = opts.embed ?? (async ({ values }) => values.map(() => [1, 0, 0, 0]));
  await seedMemory(sql);
  return { sql, ...opts, embed, close: () => sql.end() };
}

async function seedMemory(sql: Sql) {
  await sql`
    INSERT INTO space (id, container_tag, org_id)
    VALUES (${spaceId}, ${DEFAULT_CONTAINER_TAG}, ${ORG_ID})
    ON CONFLICT (container_tag, org_id) DO NOTHING`;
  await sql`
    INSERT INTO memory_entry
      (id, org_id, space_id, memory, is_latest, version, root_memory_id, memory_embedding, memory_embedding_model)
    VALUES
      (${memId}, ${ORG_ID}, ${spaceId}, ${"John prefers dark mode"}, true, 1, ${memId}, ${userVector}::vector, ${"test-embed"})`;
}