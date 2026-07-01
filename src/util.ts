// util.ts - shared helpers.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// 22-char url-safe id (nanoid-style), matches char(22) columns. Rejection sampling: bytes >= 248
// (the largest multiple of 62 below 256) are discarded rather than wrapped, so every alphabet char is
// equally likely — plain `byte % 62` skews chars 0..7 ~25% more often.
export function newId(len = 22): string {
  const LIMIT = 248; // 4 * 62
  let s = "";
  while (s.length < len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    for (let i = 0; i < bytes.length && s.length < len; i++) {
      const b = bytes[i]!;
      if (b < LIMIT) s += ALPHABET[b % ALPHABET.length];
    }
  }
  return s;
}

// pgvector text literal: [a,b,c]  -> cast with ::vector in SQL.
export const toVector = (a: number[]): string => "[" + a.join(",") + "]";

export const ORG_ID = process.env.ORG_ID ?? "eunoia_default_org";
export const DEFAULT_CONTAINER_TAG = process.env.DEFAULT_CONTAINER_TAG ?? "default";
