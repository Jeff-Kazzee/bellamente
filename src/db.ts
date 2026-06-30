// db.ts - the single DB singleton (Spec 01, 09).
// M1 (dev): external Postgres + pgvector via DATABASE_URL.
// M2: swap to PGlite (Postgres WASM) + pgvector embedded in the binary.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DB = ReturnType<typeof postgres>;

export async function makeDb(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL not set. M1 dev requires external Postgres+pgvector. (PGlite path = M2)",
    );
  }
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  await migrate(sql);
  return sql;
}

// Idempotent schema apply at boot (Spec 01). M2 will inline schema text into the binary.
async function migrate(sql: DB): Promise<void> {
  const here = import.meta.dir; // Bun
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  await sql.unsafe(schema);
}
