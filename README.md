# Bellamente

**Memoria Viva for your AI agents** — long-term memory you can actually read, correct, and trust.

[![npm](https://img.shields.io/npm/v/bellamente?label=npm&color=c4703a)](https://www.npmjs.com/package/bellamente)
[![npm downloads](https://img.shields.io/npm/dm/bellamente?label=npm%20downloads&color=c4703a)](https://www.npmjs.com/package/bellamente)
[![PyPI](https://img.shields.io/pypi/v/bellamente?label=PyPI&color=4fa487)](https://pypi.org/project/bellamente/)
[![PyPI downloads](https://img.shields.io/pypi/dm/bellamente?label=PyPI%20downloads&color=4fa487)](https://pypi.org/project/bellamente/)
[![CI](https://img.shields.io/github/actions/workflow/status/The-Little-AI-Company/bellamente/ci.yml?branch=prod&label=CI)](https://github.com/The-Little-AI-Company/bellamente/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/The-Little-AI-Company/bellamente?color=blue)](LICENSE)

Open source (MIT). Bellamente gives your AI agents long-term memory that lives on **your** machine — not in a hosted
vector database you can't see into. It's one small binary that remembers durable facts, recalls them
semantically, and plugs into the agents and chat clients you already use. Every recall is logged,
every correction is versioned, and nothing is ever silently overwritten.

> **v0.1.0 — an early but real release.** Usable and tested today; not yet complete. The
> [roadmap](ROADMAP.md) is the honest backlog — if a feature you need is listed there, it doesn't exist yet.

## Why Bellamente

- **You own it.** One binary on your machine: embedded Postgres + pgvector and local embeddings. No
  cloud, no account, no telemetry, no separate model server.
- **Inspect and trust.** Every recall is traced (the query, the matches, the scores). Every correction
  becomes a new version and the old one stays. Forgetting is reversible and audited. Nothing is ever
  silently overwritten — and you can see all of it in a local dashboard.
- **Works with your agents.** It's MCP-native: `bella mcp` gives Claude Code, Cursor, Codex, and Cline
  memory tools over stdio. Or use it as a drop-in, OpenAI-compatible proxy.
- **Secrets stay out.** Agents are told not to store credentials, and a built-in gate redacts API keys,
  tokens, and private keys before they're stored. (It targets real credential formats — not a magic
  "catches everything" promise.)

## Install

Supported today: **Windows x64** and **Linux x64**. (macOS binaries aren't published yet.)

```sh
npm install -g bellamente
bella doctor
```

…or with Python tooling:

```sh
pipx install bellamente
bella doctor
```

The package is a tiny launcher: on first run it downloads the matching binary from the
[latest GitHub release](https://github.com/The-Little-AI-Company/bellamente/releases/latest), verifies
its checksum, caches it, and runs it. You can also download the binaries directly from the release.

Just want to try a command without installing anything? `uvx bellamente doctor`.

## Run it

```sh
bella serve      # http://127.0.0.1:8080 — loopback only, no API key needed
```

First boot is zero-config: it creates the embedded database, downloads the local embedding model, and
is ready to go. `bella doctor` checks your install and shows where your data lives.

## Give your agent memory

**MCP agents (Claude Code, Cursor, Codex, Cline):**

```sh
claude mcp add bellamente -- bella mcp
```

`bella mcp` exposes nine memory tools over stdio — search, write, versioned correction, reversible
forget, list, full version history, document ingest/list, and trace inspection — all on the same local
store. No second database, no glue code.

**Any OpenAI-compatible client:** point it at Bellamente and it grounds answers with your memory
automatically, on buffered and streamed chats alike:

```sh
OPENAI_BASE_URL=http://127.0.0.1:8080/v1              # your client → Bellamente
BELLA_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1     # Bellamente → your model (e.g. Ollama)
```

Or just tell your agent to use the HTTP API directly — see [Using it](https://the-little-ai-company.github.io/bellamente/docs/using/)
for a copy-paste instruction block.

## What it can do

- **Remember & recall** — store durable facts and recall them semantically (vector + full-text search,
  recency-aware).
- **Never lose history** — near-duplicates supersede as new versions, exact duplicates are no-ops, edits
  create versions, forgetting is reversible, and only an explicit delete removes anything.
- **Auto-capture** — optionally distills durable facts from your chats using your *own* local model,
  never a cloud call.
- **Documents** — ingest markdown/text and search memories, documents, or both (hybrid).
- **Time-aware** — facts can carry validity windows for "as of" recall.
- **Portable** — export your entire memory as one JSON file and import it anywhere; embeddings
  regenerate locally on the way in.
- **Secrets gate** — credentials are redacted from memory content and metadata before storage.
- **`bella report`** — a content-free bug report: it prints a prefilled GitHub issue and sends nothing.

## How it works

Bellamente is a single process. It runs an embedded Postgres (PGlite, compiled to WebAssembly) with
pgvector for similarity search, and generates embeddings locally with a device-scaled model — a
high-quality multilingual model on capable machines, and a lightweight pure-TypeScript model on low-RAM
ones, chosen automatically so it never crashes. Everything is stored in plain, inspectable database
tables. It binds to `127.0.0.1` by default, so your memories never touch the network unless you opt in.
Prefer your own database? Point `DATABASE_URL` at an external Postgres.

## Configuration

Zero config to start. A few useful knobs (the full list is in the
[config docs](https://the-little-ai-company.github.io/bellamente/docs/config/)):

- `BELLA_HOST` (default `127.0.0.1`), `PORT` (default `8080`)
- `BELLA_PROXY_CAPTURE=0` — turn off chat auto-capture
- `BELLA_EMBED_TIER=quality|light` — force the embedding tier
- `DATABASE_URL` — use an external Postgres instead of the embedded one

## Whitepaper

There is a whitepaper: [WHITEPAPER.md](WHITEPAPER.md) (also on the website) — the premise, the
architecture, and what we measure.

## Docs & links

- **Docs:** https://the-little-ai-company.github.io/bellamente/docs/
- **API reference:** https://the-little-ai-company.github.io/bellamente/docs/api/
- **Roadmap:** [ROADMAP.md](ROADMAP.md) · **Changelog:** https://the-little-ai-company.github.io/bellamente/changelog/

## From source

```sh
bun install
bun run dev     # zero-config local server
bun run ci      # the full release gate: typecheck, tests + coverage, smoke, binary build, website
```

## Design principles

- **Local-first by default** — no hosted memory account, no model server, no cloud embeddings unless you
  opt in.
- **Inspectable** — memories live in plain tables with scores and provenance; every recall can be traced.
- **Nothing silently lost** — versioned corrections, reversible forgetting, explicit deletes.
- **Small core** — one process, one database handle, one embedding path.

## License

[MIT](LICENSE) — use it freely.

---

Bellamente is a product of **The Little AI Company**.
