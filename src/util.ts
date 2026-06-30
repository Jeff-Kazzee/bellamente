// util.ts - shared helpers.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 22-char url-safe id (nanoid-style), matches char(22) columns.
export function newId(len = 22): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i]! % ALPHABET.length];
  return s;
}

// pgvector text literal: [a,b,c]  -> cast with ::vector in SQL.
export const toVector = (a: number[]): string => "[" + a.join(",") + "]";

export const ORG_ID = process.env.ORG_ID ?? "minimem_default_org";
export const DEFAULT_CONTAINER_TAG = process.env.DEFAULT_CONTAINER_TAG ?? "default";
