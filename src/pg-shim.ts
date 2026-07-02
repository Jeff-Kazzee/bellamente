// pg-shim.ts - a minimal porsager-`postgres`-compatible tagged-SQL surface over an embedded PGlite
// instance. It exists so the tuned RRF/hybrid SQL (search.ts) and the write paths (memories.ts,
// documents.ts, profile.ts) run UNCHANGED against PGlite: we swap the driver, not the queries.
//
// Supported surface — exactly what the codebase uses (see plan §A1):
//   sql`...`                       -> Promise<row[]>   (tagged template; rows are plain objects)
//   nested fragments               -> sql`... ${sql`AND x=${v}`} ...`   ($N renumbered correctly)
//   sql.begin(async tx => {...})   -> one transaction; `tx` is a tagged template + tx.json
//     ⚠️ Inside the callback, run queries ONLY through the provided `tx`. Awaiting the OUTER `sql` there
//        deadlocks: PGlite is a single serialized connection, so the outer query queues behind the same
//        mutex the open transaction still holds and can never resolve. (porsager tolerates this via its
//        connection pool; the shim does not. The two write callers, memories.ts/documents.ts, use `tx`.)
//   sql.unsafe(text)               -> raw exec (multi-statement, incl. DO $$ ... $$ blocks)
//   sql.json(value)                -> a json/jsonb parameter
//   sql.end({timeout?})            -> close
// Value handling: a plain value -> $N param; a JS array -> a single Postgres array param; sql.json(x)
//   -> a json param; vector text literals arrive as plain strings (`${toVector(v)}::vector`) and pass
//   straight through. (All of these are verified against PGlite in test/pg-shim.test.ts.)
import type { PGlite, Transaction } from "@electric-sql/pglite";

const FRAG = Symbol("bellamente.pgshim.frag");
const JSONW = Symbol("bellamente.pgshim.json");
const JSON_OID = 114; // pg_type OID for `json` — tells PGlite to serialize the value as JSON.

type JsonW = { [JSONW]: true; value: unknown };
const isJsonW = (x: unknown): x is JsonW =>
  typeof x === "object" && x !== null && (x as Record<PropertyKey, unknown>)[JSONW] === true;

// A fragment keeps the raw template pieces lazily, so it can be EITHER interpolated into a parent query
// (spliced inline, params renumbered) OR awaited to execute on its own — never both by accident.
interface Frag {
  [FRAG]: true;
  strings: readonly string[];
  values: readonly unknown[];
}
const isFrag = (x: unknown): x is Frag =>
  typeof x === "object" && x !== null && (x as Record<PropertyKey, unknown>)[FRAG] === true;

/** Flatten a template (with possibly-nested fragments) into one SQL string + parallel params/paramTypes.
 *  A single shared `params` accumulator across the recursion makes `$N` sequential and correct by
 *  construction — no regex renumbering, so arbitrarily nested fragments compose safely. */
export function compose(
  strings: readonly string[],
  values: readonly unknown[],
): { text: string; params: unknown[]; paramTypes: number[] } {
  const params: unknown[] = [];
  const paramTypes: number[] = [];
  const walk = (strs: readonly string[], vals: readonly unknown[]): string => {
    let text = "";
    for (let i = 0; i < strs.length; i++) {
      text += strs[i];
      if (i < vals.length) {
        const v = vals[i];
        if (isFrag(v)) {
          text += walk(v.strings, v.values); // inline: shares `params` -> $N stays sequential
        } else if (isJsonW(v)) {
          params.push(v.value);
          paramTypes.push(JSON_OID);
          text += "$" + params.length;
        } else {
          params.push(v);
          paramTypes.push(0); // 0 = let Postgres infer (arrays -> array, strings -> text, etc.)
          text += "$" + params.length;
        }
      }
    }
    return text;
  };
  const text = walk(strings, values);
  return { text, params, paramTypes };
}

type Queryable = Pick<PGlite | Transaction, "query">;

// Turn compose() output into a PGlite call; pass paramTypes ONLY when a json param is present, so plain
// queries behave exactly like an untyped PGlite query.
function run(pg: Queryable, strings: readonly string[], values: readonly unknown[]): Promise<any[]> {
  const { text, params, paramTypes } = compose(strings, values);
  const opts = paramTypes.some((t) => t !== 0) ? { paramTypes } : undefined;
  return pg.query(text, params as any[], opts).then((r) => r.rows);
}

// The awaitable produced by the `sql` / `tx` tag: a Frag that is ALSO a thenable. Interpolating it
// leaves it lazy (isFrag -> spliced by compose); awaiting it composes + executes exactly once (memoized).
function makeQuery(strings: readonly string[], values: readonly unknown[], pg: Queryable): any {
  let promise: Promise<any[]> | null = null;
  const exec = (): Promise<any[]> => (promise ??= run(pg, strings, values));
  return {
    [FRAG]: true,
    strings,
    values,
    then: (onF: any, onR: any) => exec().then(onF, onR),
    catch: (onR: any) => exec().catch(onR),
    finally: (onFin: any) => exec().finally(onFin),
  };
}

export interface Tx {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  json: (value: unknown) => JsonW;
  unsafe: (query: string, params?: unknown[]) => Promise<any[]>; // raw/multi-statement (migrations); porsager tx has this natively
}
export interface Sql {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  begin: <T>(cb: (tx: Tx) => Promise<T>) => Promise<T>;
  unsafe: (query: string, params?: unknown[]) => Promise<any[]>;
  json: (value: unknown) => JsonW;
  end: (opts?: { timeout?: number }) => Promise<void>;
}

/** The structural DB type consumers depend on. Both this PGlite shim and porsager `postgres` satisfy it. */
export type DB = Sql;

const jsonWrap = (value: unknown): JsonW => ({ [JSONW]: true, value });

export function makePgliteSql(pg: PGlite): Sql {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => makeQuery(strings, values, pg);

  sql.json = jsonWrap;

  sql.unsafe = (query: string, params?: unknown[]): Promise<any[]> => {
    if (params && params.length) return pg.query(query, params as any[]).then((r) => r.rows);
    // No params: exec() so multi-statement scripts (schema.sql, DO $$...$$ blocks) run as one batch.
    return pg.exec(query).then((results) => (results.length ? results[results.length - 1]!.rows : []));
  };

  // NOTE: use ONLY `tx` for queries inside `cb` — awaiting the outer `sql` here deadlocks (see header).
  sql.begin = <T>(cb: (tx: Tx) => Promise<T>): Promise<T> =>
    pg.transaction(async (pgTx) => {
      const tx: any = (strings: TemplateStringsArray, ...values: unknown[]) => makeQuery(strings, values, pgTx);
      tx.json = jsonWrap;
      tx.unsafe = (query: string, params?: unknown[]): Promise<any[]> => {
        if (params && params.length) return pgTx.query(query, params as any[]).then((r) => r.rows);
        return pgTx.exec(query).then((results) => (results.length ? results[results.length - 1]!.rows : []));
      };
      return cb(tx as Tx);
    });

  sql.end = (_opts?: { timeout?: number }): Promise<void> => pg.close();

  return sql as Sql;
}
