# Bellamente Roadmap

**v0.0.1 is an early release.** It is usable and it is honest — and it is not at all complete.
This page is the actual backlog, in priority order. If a feature you need is listed below, it does
not exist yet.

Also on the website: https://bellamente.vercel.app/roadmap

## Now — shipped in v0.0.1

- Memory lifecycle: write with dedup/supersede, versioned corrections, reversible forgetting,
  hard delete, full version-chain reads.
- Semantic memory recall + hybrid document search (vector + full-text, rank-fused).
- Drop-in `/v1/chat/completions` proxy with memory grounding on **buffered and streamed** chats
  (the model's `searchMemory` call is intercepted even mid-stream).
- Auto-capture with **local LLM distillation**: durable facts extracted from your chats by your own
  local model — heuristic fallback, sensitive-content exclusion, every capture traced and reversible.
- Recall traces (`/inspect`) + a dashboard with edit / forget / delete / history.
- One binary; embedded Postgres + pgvector; local device-scaled embeddings; loopback by default;
  append-only migrations.
- 116 behavior tests under a coverage-gated build.

## Next — the trust loop, finished

- Full-text search over memories (exact names, codes, rare tokens — not just semantic).
- MCP server (`bella mcp`) so agent harnesses plug in directly.
- Recency-aware ranking.
- Retrieval eval harness with published recall@k / latency numbers.
- Richer trust views: rejected-capture reasons, version diffs, provenance trees.
- Export / import — your memory is a file you can take anywhere.

## Later — memory-system parity

- Time-aware facts (`valid_from` / `valid_to`, "as of" queries).
- Review queue for inferred (auto-captured) memories: approve / decline before they're trusted.
- Profile rebuild rules, pinned facts, profile+search in one call.
- Context-window preview: see exactly what your agent will see, before it sees it.
- Local folder-memory contract (a watched directory that IS your memory).
- Reranking + result diversity; usage analytics; scoped API keys.

## Someday — bigger bets (plugins over bloat)

- Memory graph view + export.
- Optional cross-encoder reranker (downloaded on demand, device-scaled).
- Content extractors (PDF, code, web) and connectors (filesystem/Obsidian first).
- SDKs, editor integrations, desktop shell.

## What will never change

Local-first by default. No telemetry. Every recall traceable. Every correction versioned.
Forgetting reversible and audited. If a feature can't be made inspectable, it doesn't ship.
