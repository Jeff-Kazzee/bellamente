// db.ts - the single DB singleton (Spec 01, 09).
// M1 (dev): external Postgres + pgvector via DATABASE_URL.
// M2: swap to PGlite (Postgres WASM) + pgvector embedded in the binary.
import postgres from "postgres";
// Embedded at build time (Bun text import) so the schema ships inside the binary.
import schemaSql from "../schema.sql" with { type: "text" };

export type DB = ReturnType<typeof postgres>;

export async function makeDb(): Promise<DB> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL not set. M1 dev requires external Postgres+pgvector. (PGlite path = M2)",
    );
  }
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  await sql.unsafe(schemaSql); // idempotent schema apply at boot (Spec 01)
  return sql;
}
