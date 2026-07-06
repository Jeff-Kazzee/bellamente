# Bellamente Agent Context Pack

This is the full Markdown context pack for Bellamente. Agents can ingest this single file when context allows, or fetch the rendered section pages under `https://the-little-ai-company.github.io/bellamente/docs/` when they only need part of the public documentation.

Canonical site: https://the-little-ai-company.github.io/bellamente/
Source repository: https://github.com/The-Little-AI-Company/bellamente
Latest release: https://github.com/The-Little-AI-Company/bellamente/releases/tag/v0.0.3

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

Current release: Bellamente v0.0.3.

Package-manager installs:

```sh
npm install -g bellamente
pipx install bellamente
```

One-shot Python run:

```sh
uvx bellamente doctor
```

The npm and PyPI packages are tiny launchers: when no verified cache exists on supported Windows x64
and Linux x64 machines, they download the matching GitHub release binary, verify it against
`SHA256SUMS.txt`, and run `bella`. `uvx` does not install a persistent `bella` command; use
`pipx install bellamente` for that.

- [Windows x64](https://github.com/The-Little-AI-Company/bellamente/releases/download/v0.0.3/bella-windows-x64.exe): `bella-windows-x64.exe`
- [Linux x64](https://github.com/The-Little-AI-Company/bellamente/releases/download/v0.0.3/bella-linux-x64): `bella-linux-x64`
- [SHA256 checksums](https://github.com/The-Little-AI-Company/bellamente/releases/download/v0.0.3/SHA256SUMS.txt): `SHA256SUMS.txt`

Bellamente ships as one binary named `bella` or `bella.exe`. No Docker, cloud account, or hosted Bellamente service is required for v0.0.3.

### Roadmap

Bellamente v0.0.3 is an early release. It is usable and honest, but it is not complete. The roadmap is a public backlog and should be treated as direction, not as a rigid queue.

Items can ship out of order, and multiple items may land together when one implementation clears several gaps. When shipped, work moves from the roadmap to the changelog.

Now in v0.0.3:

- Memory lifecycle with versioned corrections and reversible forgetting.
- Memory recall: semantic + full-text (exact names, codes, rare tokens), recency-weighted, with a diversity pass.
- Hybrid document search.
- Time-aware facts with "as of" recall.
- Export and import: memory is one portable versioned JSON file.
- Drop-in proxy with memory grounding on buffered and streamed chats.
- Auto-capture with local LLM distillation.
- Full recall traces.
- Inspect dashboard.
- Retrieval eval harness with published numbers.
- One binary with embedded Postgres plus pgvector, local embeddings, and loopback by default.
- Native MCP server (`bella mcp`) for MCP-native agents.

Next focus:

- Richer trust views: rejected captures, version diffs, provenance trees.

Later and bigger bets include inferred-memory review, context-window preview, memory graph, optional reranker, content extractors, filesystem and Obsidian connectors, SDKs, editor integrations, and a desktop shell.

### Changelog

Bellamente v0.0.2 shipped on 2026-07-05.

Release URL: https://github.com/The-Little-AI-Company/bellamente/releases/tag/v0.0.2
Release target: `prod`.

Shipped:

- npm and PyPI launchers that verify and run the matching GitHub release binary.
- GitHub Actions release gate and GitHub Pages deploy wiring under The Little AI Company org.
- Full-functionality release smoke proof for real embedder, database boot, proxy memory loops,
  export/import, temporal recall, and hard-delete scope.
- Local-first memory lifecycle.
- Document recall.
- OpenAI-compatible proxy.
- Auto-capture.
- Recall traces.
- Dashboard inspection.
- Embedded Postgres plus pgvector.
- Local embeddings.
- Direct release binaries for Windows and Linux.

Bellamente v0.0.3 shipped on 2026-07-06.

Release URL: https://github.com/The-Little-AI-Company/bellamente/releases/tag/v0.0.3
Release target: `prod`.

Shipped:

- Error observability: content-free error capture with redaction at the store boundary, a durable
  error store, and an Errors view in the dashboard.
- Audit fixes: silently skipped document chunks are now counted and surfaced; a corrupted embedder
  pin fails loud with an atomic rewrite instead of re-guessing the model; concurrent memory edits
  can no longer leave two latest versions in one chain (flip-first writes, a boot-time repair
  migration, and a unique one-latest-per-chain index).
- Dashboard auth gating fix, markdown-chunker hang fix, profile write validation, and a coverage
  gate that fails closed on partial reports.
- Release truth: public direct downloads and package launchers stay limited to tested Windows x64
  and Linux x64 binaries; binaries for untested platforms were withdrawn from the v0.0.2 release.
- The public roadmap moved already-shipped work (memory full-text search, recency-weighted ranking,
  temporal validity, export/import, the retrieval eval harness) into "Now".

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

- [Docs overview and install](https://the-little-ai-company.github.io/bellamente/docs/)
- [Using Bellamente](https://the-little-ai-company.github.io/bellamente/docs/using/)
- [API reference](https://the-little-ai-company.github.io/bellamente/docs/api/)
- [Config reference](https://the-little-ai-company.github.io/bellamente/docs/config/)
- [Roadmap](https://the-little-ai-company.github.io/bellamente/roadmap/)
- [Changelog](https://the-little-ai-company.github.io/bellamente/changelog/)

## Agent Loading Pattern

Start at `https://the-little-ai-company.github.io/bellamente/llms.txt`. Fetch `https://the-little-ai-company.github.io/bellamente/llms-full.md` for full context. Fetch the rendered `/bellamente/docs/` pages for partial context. Use `https://the-little-ai-company.github.io/bellamente/sitemap.xml` to discover all indexable files.
