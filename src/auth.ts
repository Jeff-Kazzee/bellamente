// auth.ts - zero-config local auth. A local-first tool must work with NO .env and NO shared key
// (Jeff's call, 2026-07-02 — the old flow made every user copy .env.example with "change-me").
//
// The rule, in order:
//  1. BELLA_API_KEY set        -> auth REQUIRED with that key (explicit choice always wins).
//  2. binding to loopback      -> NO auth. Threat model: any local process could also read the
//     (the default)               on-disk data dir directly, so a bearer on 127.0.0.1 adds no real
//                                 margin — it only adds setup friction. Set BELLA_API_KEY to
//                                 require one anyway.
//  3. binding beyond loopback  -> a key is AUTO-GENERATED on first boot, persisted to
//                                 <data>/apikey (stable across restarts), and required. Exposure
//                                 without auth is never the default.
import { timingSafeEqual, randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { brandEnv } from "./env";
import { dataDir } from "./paths";

export type AuthConfig = { required: boolean; key: string | null; source: "env" | "generated" | "none" };

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h === "::1" || /^127\./.test(h);
}

export function resolveAuth(host: string, opts?: { dataDir?: string }): AuthConfig {
  const envKey = brandEnv("API_KEY");
  if (envKey) return { required: true, key: envKey, source: "env" };
  if (isLoopbackHost(host)) return { required: false, key: null, source: "none" };

  const file = join(opts?.dataDir ?? dataDir(), "apikey");
  let key = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!key) {
    key = randomBytes(24).toString("base64url");
    writeFileSync(file, key + "\n", { mode: 0o600 });
  }
  return { required: true, key, source: "generated" };
}

// Constant-time bearer comparison (avoids leaking the key via response-timing on byte-by-byte compare).
export function bearerOk(header: string, key: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from("Bearer " + key);
  return a.length === b.length && timingSafeEqual(a, b); // length differs first (cheap, not secret)
}
