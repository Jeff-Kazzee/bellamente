# minimem

Single-binary personal memory server - a minimal, faithful re-implementation of
Supermemory's memory subsystem (store facts, recall them semantically, and an
OpenAI-compatible proxy that auto-injects memory + profile).

Reverse-engineered from the decompiled bundle in the sibling `sm-decomp` project.
Clean-room: no decompiled code is copied in; algorithms are ported from documented behavior.

## Status
- M1 core loop: WIRED + verified end-to-end against pgvector (write -> embed -> store -> cosine recall).
- Embeddings: OpenAI fallback (text-embedding-3-small, dimensions:768) wired; local model = TODO (M2).
- M2 single binary (PGlite + local model + `bun build --compile`): TODO.
- M3 proxy upstream-forward + tool-call interception: TODO (tool + profile injection already wired).

## Architecture (one process)
One Hono app + two singletons: `sql` (pgvector) and `embed` (768-d). Every feature is a
route module sharing `ctx = { sql, embed }`. The proxy calls search/profile in-process.

```
src/index.ts     entrypoint: singletons + mount all routes + bearer auth + listen
src/db.ts        DB singleton (postgres.js; applies schema.sql at boot). M2 -> PGlite.
src/embed.ts     embed({ values, taskType }) -> 768-d; EMBED_DIM=768; OpenAI fallback wired
src/util.ts      newId(22), toVector(), ORG_ID, DEFAULT_CONTAINER_TAG
src/memories.ts  POST/GET /memories          (port of $V2)
src/search.ts    POST /search + searchMemories()  (cosine, threshold 0.4, dedup, cap 25)
src/profile.ts   GET/PUT /profile + injection template + loadProfile()
src/proxy.ts     POST /v1/chat/completions   (tool + profile injection; forward = M3)
schema.sql       full pgvector DDL (applied at boot)
docs/            PRD + 11 subsystem specs
```

## Quick start (dev, M1)
```
cp .env.example .env          # set MINIMEM_API_KEY, DATABASE_URL, OPENAI_API_KEY, EMBEDDING_PROVIDER=openai
bun install
docker run -d --name minimem-pg -p 5433:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=minimem pgvector/pgvector:pg16
bun run dev
```

Example:
```
curl -s localhost:8080/health
curl -s localhost:8080/memories -H "authorization: Bearer $MINIMEM_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"containerTag":"user_123","memories":[{"content":"John prefers dark mode","isStatic":true}]}'
curl -s localhost:8080/search -H "authorization: Bearer $MINIMEM_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"q":"what display setting does John like","containerTag":"user_123"}'
```

## Build single binary (M2)
```
bun run build      # -> ./minimem  (PGlite + local model embedded)
./minimem
```

## API
- POST /memories  - create 1..100 memories
- GET  /memories  - list latest, non-forgotten
- POST /search    - semantic recall (cosine, threshold 0.4)
- GET/PUT /profile
- POST /v1/chat/completions - OpenAI-compatible proxy
See docs/PRD.md and docs/08-api.md.

## Provenance / fidelity
Specs mark "verbatim" (from decompiled source) vs "[DESIGN]" (designed here because the
source lacked it - notably the document->memory extraction prompt and the local embedding
model name, which are not present in the decompiled output).
