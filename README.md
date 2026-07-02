# Bellamente
Memoria Viva for your AI agents.

(formerly Eunoia — the internal identifiers keep that name during the staged
migration; see Compatibility below)

Bellamente is a local-first memory substrate for AI agents. It stores durable facts
and source documents, recalls them semantically, and gives chat clients a small
Chat Completions-compatible proxy for injecting relevant memory and profile context into local LLM servers.

The product thesis is simple: agents need a well-ordered mind that stays close
to the user, remains inspectable, and can run without a hosted memory service.
Bellamente keeps the core small enough to reason about while leaving room for richer
recall traces, document ingestion, and profile-aware workflows.

## Status
**Pre-release.** v0.0.1 sign-off is blocked on one remaining item (spec in `docs/HANDOFF-CODEX.md`):
capture v2 (LLM distillation through the local upstream). Streamed memory-tool reinvocation shipped.
No release artifacts are published and the repository stays private until it lands.

- Core loop (write -> embed -> store -> cosine recall): WIRED + verified end-to-end on pgvector.
- Memory lifecycle: COMPLETE. Writes dedup exact duplicates and SUPERSEDE near-duplicates as new
  versions (old versions stay inspectable); memories can be read with full version history, edited
  (content edits create a new version), soft-forgotten (reversible), or hard-deleted — via API and
  dashboard. Nothing is silently overwritten.
- Embeddings: LOCAL + in-process, DEVICE-SCALED (no cloud, no model server). Capable machines use
  multilingual-e5-small (WASM worker, 384-d — best quality + multilingual); low-RAM machines auto-fall-back
  to a pure-TS static Model2Vec model (potion-retrieval-32M, ~440 MB, never crashes). The chosen model/dim
  is pinned per data dir. OpenAI is an optional dev fallback.
- Database: EMBEDDED by default - PGlite (Postgres compiled to WASM) + pgvector, running
  in-process inside the binary. No Docker, no server. Verified in the compiled binary
  (initdb, `<=>` cosine, full-text, transactional writes, persistence across restart).
  `DATABASE_URL` stays as an advanced override for external Postgres. Schema changes ship as
  append-only migrations applied at boot (schema_migrations), so upgrades never strand existing data.
- M2 standalone binary: DONE (verified compiled binary on Windows + Linux; see docs/STATUS.md).
- M3 proxy upstream-forward + tool-call interception: WIRED for buffered AND streamed `/v1/chat/completions`-compatible local servers, with upstream timeouts (BELLA_UPSTREAM_TIMEOUT_MS) and stream-stall detection (BELLA_STREAM_IDLE_TIMEOUT_MS). Recall failures degrade to a memory-less answer instead of failing the chat turn. `stream:true` requests get the same memory tool round as buffered ones — the proxy classifies the upstream stream, runs `searchMemory` when the model calls it, re-invokes upstream with the results, and streams only the final answer to the client. Provider-specific shapes (Anthropic/Google) remain a follow-up.
- Document ingestion: WIRED. POST /documents chunks + embeds markdown (structure-aware, token-budget
  guarded); chunks are searchable via /search searchMode documents|hybrid (vector + full-text, RRF-fused).
- Auto-capture: the proxy remembers durable first-person facts from your chats — conservatively,
  through the standard dedup path, with a `capture` trace for every event and a sensitive-content
  exclusion list (credentials/financial/medical are never stored). ON by default;
  `BELLA_PROXY_CAPTURE=0` disables. Boot announces the capture state.
- Inspect API: recall/search/proxy traces are durable and readable via `/inspect`; proxy `answered` traces show which memories fed the final model response.
- Server binds 127.0.0.1 by default (BELLA_HOST to override) — memories and trace text stay off the LAN unless you opt in.

## Architecture (one process)
One Hono app + two singletons: `sql` (pgvector) and `embed` (384-d, local). Every
feature is a route module sharing `ctx = { sql, embed }`. The proxy calls
search/profile in-process.

```
src/index.ts     entrypoint: singletons + embed prewarm + mount routes + bearer auth + listen (loopback by default)
src/db.ts        DB handle: embedded PGlite (Postgres in WASM) by default; DATABASE_URL = external-PG override; applies schema.sql + migrations at boot
src/migrations.ts  append-only schema migrations (schema_migrations table; rules in the file header)
src/pg-shim.ts   porsager-compatible `sql` tag over PGlite (so the tuned SQL runs unchanged)
src/embed.ts     embed({ values, taskType }); device-scaled tier -> WASM worker (e5) or static engine; OpenAI fallback
src/embed-model2vec.ts  pure-TS static Model2Vec ("potion") engine for the low-RAM tier (no worker, never crashes)
src/util.ts      newId(22), toVector(), ORG_ID, DEFAULT_CONTAINER_TAG
src/memories.ts  memory lifecycle: POST/GET /memories, GET/PATCH/DELETE /memories/:id, POST /memories/:id/forget (dedup + supersede on write)
src/documents.ts document ingestion: POST/GET/DELETE /documents (chunk -> embed -> store)
src/chunk.ts     markdown-aware chunker (structure-aware, embed-token-budget guarded)
src/search.ts    POST /search + searchMemories()/searchChunks()  (cosine + full-text, RRF fusion, per-model threshold, cap 25)
src/profile.ts   GET/PUT /profile + injection template + loadProfile()
src/proxy.ts     POST /v1/chat/completions   (local Chat Completions proxy: memory tool loop for buffered + streamed requests, upstream timeouts)
schema.sql       full pgvector DDL (applied at boot; changes to shipped tables go through src/migrations.ts)
docs/            PRD + 11 subsystem specs
```

## Quick start (dev)
```
cp .env.example .env          # set BELLA_API_KEY (defaults: local embeddings + embedded DB, no cloud, no Docker)
bun install
bun run dev                   # first boot creates the embedded DB, downloads the embedding model, and prewarms
```

Example:
```
curl -s localhost:8080/health
curl -s localhost:8080/memories -H "authorization: Bearer $BELLA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"containerTag":"user_123","memories":[{"content":"John prefers dark mode","isStatic":true}]}'
curl -s localhost:8080/search -H "authorization: Bearer $BELLA_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"q":"what theme does John like","containerTag":"user_123"}'
```

## Embeddings: local + device-scaled
Bellamente picks the embedder by device RAM so it "just works" without crashing low-end machines:
- **quality** (default, capable machines): `Xenova/multilingual-e5-small` (WASM worker, 384-d) — best
  quality + multilingual; query/passage prefixes, mean pooling, L2-normalized.
- **light** (auto on < ~7 GB RAM): `minishlab/potion-retrieval-32M` — a pure-TS static Model2Vec model
  (~440 MB, no worker, never OOM-crashes). The threaded-WASM OOM is uncatchable, so the tier is chosen
  proactively by total RAM.

Override with `BELLA_EMBED_TIER=quality|light`, `BELLA_EMBED_MIN_RAM_GB`, or pin `LOCAL_EMBED_MODEL`
(`EMBED_DIM` auto-follows a known model). The chosen `{model, dim}` is pinned at first DB init
(`<data>/embedder.json`), so a later RAM/hardware change won't flip it and break your stored memories.
`EMBEDDING_PROVIDER=openai` is an optional cloud fallback. See `docs/02-embedding.md` for local design docs.

## Build single binary (M2)
```
bun run build      # -> ./bella / bella.exe (+ legacy ./eunoia copy)
./bella
```

## API
- POST   /memories            - write 1..100 memories (exact dups -> "unchanged"; near-dups -> "superseded"
                                new version; `dedupe:false` bypasses). Response reports per-item action.
- GET    /memories            - list latest, non-forgotten
- GET    /memories/:id        - one memory + its full version chain (forgotten included — inspection hides nothing)
- PATCH  /memories/:id        - correct a memory (content change -> NEW version; flag-only -> in place)
- POST   /memories/:id/forget - soft-forget the whole chain (reversible with {undo:true})
- DELETE /memories/:id        - hard-delete the whole chain + provenance (the only physical removal)
- POST   /documents           - ingest a markdown/text document (chunk -> embed -> searchable)
- GET    /documents[/:id]     - list documents / one document + chunks with quality flags
- DELETE /documents/:id       - delete a document + its chunks
- POST   /search              - recall (memories: cosine; documents: cosine + full-text RRF; hybrid: rank-fused; emits trace headers)
- GET    /inspect             - recent recall/proxy traces and per-trace details
- GET/PUT /profile
- POST /v1/chat/completions - local Chat Completions proxy with the memory tool loop on buffered and streamed requests
See docs/PRD.md and docs/08-api.md.

### Server + tuning env vars
- `BELLA_HOST` (default `127.0.0.1`), `PORT` (default 8080).
- `BELLA_SUPERSEDE_THRESHOLD` — cosine floor for supersede-on-write (default 0.95 transformer/OpenAI, 0.98 static tier).
- `SEARCH_THRESHOLD` — recall similarity floor (per-model default).
- `BELLA_PROXY_CAPTURE` (default on) — chat auto-capture; `0` disables. Captures are traced + reversible.
- `BELLA_UPSTREAM_TIMEOUT_MS` (default 120000) — proxy upstream deadline (connect + buffered body read).
- `BELLA_STREAM_IDLE_TIMEOUT_MS` (default 120000) — proxy stream-stall detector (per pending read).

## Compatibility (staged rebrand)
This is a staged rebrand: everything a human reads says Bellamente, and nothing
an existing setup depends on breaks.
- Env vars: `BELLA_*` are the documented names; every one also accepts the legacy
  `EUNOIA_*` spelling as a permanent alias (`BELLA_` wins when both are set; the
  server logs a one-line note when a legacy name is used).
- HTTP headers stay `x-eunoia-*` (wire contract).
- The data directory is unchanged (renaming it would orphan existing memories).
- `/health` still reports `service:"eunoia"` (the doctor authenticity contract)
  plus `brand:"bellamente"`.
- The build emits a legacy `eunoia` / `eunoia.exe` binary copy alongside `bella`.

## Design principles
- Local-first by default: no hosted memory account, no model server, no cloud
  embeddings unless you opt in.
- Inspectable recall: memories and chunks are stored in plain database tables with
  scores, provenance fields, and room for recall tracing.
- Small core: one process, one database handle, one embedding path, and route modules
  that call each other directly.
- Agent-friendly surface: direct memory writes, semantic search, profile context, and
  a proxy path that can become transparent memory for `/v1/chat/completions`-compatible local clients.
