# 00 - Architecture

## Purpose
Define process shape and module wiring.

## Process model
- One OS process = one Hono app. No internal HTTP between features; they call each other
  as functions.
- Two singletons created once at boot in src/index.ts:
  - db    -> Spec 01 (pgvector client / PGlite)
  - embed -> Spec 02 (768-d embedding fn)
- Passed as ctx = { db, embed } to every route module.

## Module graph
- index.ts -> db.ts (singleton)
- index.ts -> embed.ts (singleton)
- index.ts -> memories.ts (ctx): POST/GET/PATCH /memories
- index.ts -> search.ts (ctx): POST /search
- index.ts -> profile.ts (ctx): GET/PUT /profile
- index.ts -> proxy.ts (ctx): POST /v1/chat/completions
- proxy.ts calls search.ts + profile.ts in-process (plain function calls, no HTTP).

## Boot sequence (port of startup hX2)
1. Unlock encrypted local storage (machine-id key).
2. Run embedded migrations (idempotent, hash-tracked).
3. Prewarm embedding model (skip if MINIMEM_SKIP_EMBEDDING_PREWARM=1).
4. Start cron (forget_after expiry sweep).
5. Listen.

## Acceptance
- index.ts is the only entrypoint; killing it stops everything.
- No feature opens its own DB connection or its own embedder.
