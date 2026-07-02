# Bellamente Agent Context Pack

This is the full Markdown context pack for Bellamente. Agents can ingest this single file when context allows, or fetch section documents from `/docs/*.md` when they only need part of the public documentation.

Canonical site: https://bellamente.vercel.app/
Source repository: https://github.com/Jeff-Kazzee/bellamente
Latest release: https://github.com/Jeff-Kazzee/bellamente/releases/tag/v0.0.1

## Full Site Documents

### Home

Bellamente is local-first memory for AI agents. The promise is simple: every recall is visible, every correction is versioned, and every byte stays on your machine.

Tagline: Memoria Viva for your AI agents.

Bellamente is memory you can inspect and trust. It is not a hosted memory SaaS and does not phone home by default. It is designed for developers and agent operators who want durable local memory without giving an external vendor their agent context.

Core claims:

- Inspect: every recall is durably logged with the query, matched memories, scores, latency, and below-threshold misses.
- Correct: edits create new versions; previous versions remain in the chain. Forgetting is reversible and audited. Hard delete is explicit.
- Local: Bellamente runs with embedded Postgres plus pgvector, local embedding models, and loopback binding by default.
- Drop-in proxy: any OpenAI-compatible client can point at `http://127.0.0.1:8080/v1`. Bellamente retrieves relevant memories, injects them into the request, and returns the upstream model answer with `x-bella-trace-id` for inspection.

Example CLI flow:

```sh
bella serve
curl -s :8080/memories -d '{"memories":[{"content":"Jeff prefers dark mode"}]}'
curl -s :8080/search -d '{"q":"what theme does Jeff like?"}'
```

### Downloads

Current release: Bellamente v0.0.1.

- [Windows x64](https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-windows-x64.exe): `bella-windows-x64.exe`
- [macOS Apple silicon](https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-darwin-arm64): `bella-darwin-arm64`
- [macOS Intel](https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-darwin-x64): `bella-darwin-x64`
- [Linux x64](https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/bella-linux-x64): `bella-linux-x64`
- [SHA256 checksums](https://github.com/Jeff-Kazzee/bellamente/releases/download/v0.0.1/SHA256SUMS.txt): `SHA256SUMS.txt`

Bellamente ships as one binary named `bella` or `bella.exe`. No Docker, cloud account, or hosted Bellamente service is required for v0.0.1.

### Roadmap

Bellamente v0.0.1 is an early release. It is usable and honest, but it is not complete. The roadmap is a public backlog and should be treated as direction, not as a rigid queue.

Items can ship out of order, and multiple items may land together when one implementation clears several gaps. When shipped, work moves from the roadmap to the changelog.

Now in v0.0.1:

- Memory lifecycle with versioned corrections and reversible forgetting.
- Semantic and hybrid document search.
- Drop-in proxy with memory grounding on buffered and streamed chats.
- Auto-capture with local LLM distillation.
- Full recall traces.
- Inspect dashboard.
- One binary with embedded Postgres plus pgvector, local embeddings, and loopback by default.

Next focus:

- Full-text search over memories for exact names, codes, and rare tokens.
- MCP server via `bella mcp` so agent tools can plug in directly.
- Recency-aware ranking.
- Retrieval eval harness with published numbers.
- Richer trust views: rejected captures, version diffs, provenance trees.
- Export and import so memory is portable.

Later and bigger bets include time-aware facts, inferred-memory review, context-window preview, memory graph, optional reranker, content extractors, filesystem and Obsidian connectors, SDKs, editor integrations, and a desktop shell.

### Changelog

Bellamente v0.0.1 shipped on 2026-07-02.

Release URL: https://github.com/Jeff-Kazzee/bellamente/releases/tag/v0.0.1
Release target: `prod`.

Shipped:

- Local-first memory lifecycle.
- Document recall.
- OpenAI-compatible proxy.
- Auto-capture.
- Recall traces.
- Dashboard inspection.
- Embedded Postgres plus pgvector.
- Local embeddings.
- Direct release binaries for Windows, macOS, and Linux.

### Agent Use Guidance

Use Bellamente as a local memory layer for AI agents. Do not describe it as hosted SaaS. Do not imply that Bellamente phones home, syncs to a Bellamente cloud, or stores user memories outside the user's machine by default.

Preferred phrases:

- local-first memory for AI agents
- inspectable recall traces
- versioned corrections
- reversible forgetting
- embedded Postgres plus pgvector
- local embeddings
- OpenAI-compatible memory proxy
- one binary, no Docker, no account

Machine contracts:

- CLI: `bella`
- Environment variables: `BELLA_*`
- HTTP headers: `x-bella-*`
- Health check identity: `service: "bellamente"`
- Dashboard API key storage key: `bellamente.apikey`

Do not invent compatibility aliases or use the old pre-release working title. The public brand and current identifiers are Bellamente and `bella`.

## Section Documents

- [Home](https://bellamente.vercel.app/docs/home.md)
- [Downloads](https://bellamente.vercel.app/docs/downloads.md)
- [Roadmap](https://bellamente.vercel.app/docs/roadmap.md)
- [Changelog](https://bellamente.vercel.app/docs/changelog.md)
- [Agent guide](https://bellamente.vercel.app/docs/agent-guide.md)

## Agent Loading Pattern

Start at `/llms.txt`. Fetch `/llms-full.md` for full context. Fetch `/docs/*.md` for partial context. Use `/sitemap.xml` to discover all indexable files.