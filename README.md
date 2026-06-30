# minimem

Single-binary personal memory server - a minimal, faithful re-implementation of
Supermemory's memory subsystem (store facts, recall them semantically, and an
OpenAI-compatible proxy that auto-injects memory + profile).

Reverse-engineered from the decompiled bundle in the sibling `sm-decomp` project.
This repo is intentionally clean-room: no decompiled code is copied in.

## Status: scaffold (M1 in progress)
Routes and algorithms are stubbed with TODOs that point at the specs. Nothing is wired to a
real DB or embedding model yet.

## Architecture (one process)
One Hono app + two singletons: `db` (pgvector/PGlite) and `embed` (768-d). Every feature is a
route module sharing `ctx = { db, embed }`. The proxy calls search/profile in-process.

```
src/index.ts   entrypoint: singletons + mount all routes + auth + listen
src/db.ts      DB singleton (M1 external PG; M2 PGlite + pgvector embedded)
src/embed.ts   embed({ values, taskType }) -> 768-d; EMBED_DIM=768
src/memories.ts  POST/GET/PATCH /memories   (port of $V2)
src/search.ts    POST /search + searchMemories()
src/profile.ts   GET/PUT /profile + injection template
src/proxy.ts     POST /v1/chat/completions  (tool injection + interception)
schema.sql       full pgvector DDL (applied at boot)
docs/            PRD + 11 subsystem specs
```

## Quick start (dev, once wired)
```
cp .env.example .env          # set MINIMEM_API_KEY, DATABASE_URL, OPENAI_API_KEY
bun install
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
bun run dev
```

## Build single binary (M2)
```
bun run build      # -> ./minimem  (PGlite + local model embedded)
./minimem
```

## API
- POST /memories  - create 1..100 memories
- POST /search    - semantic recall (cosine, threshold 0.4)
- GET/PUT /profile
- POST /v1/chat/completions - OpenAI-compatible proxy

See docs/PRD.md and docs/08-api.md.

## Roadmap
- M1 core loop (db + embed + /memories + /search) on external PG + OpenAI embeds
- M2 single binary: PGlite + pgvector + local 768-d model, `bun build --compile`
- M3 proxy + profile injection
- M4 lifecycle: versioning, forgetting, expiry cron

## Provenance / fidelity
Specs mark "verbatim" (from decompiled source) vs "[DESIGN]" (designed here because the
source lacked it - notably the document->memory extraction prompt and the local embedding
model name, which are not present in the decompiled output).
