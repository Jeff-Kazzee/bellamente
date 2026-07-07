---
layout: ../../layouts/DocsLayout.astro
title: Overview & install
description: What Bellamente is, how to install it, and the zero-config first run.
---

# Bellamente docs

Bellamente is a **local-first memory tool for AI agents**. It stores durable facts and documents,
recalls them semantically, and sits in front of your local LLM as a drop-in
`/v1/chat/completions` proxy that injects relevant memory — with a durable trace of exactly what
it did. One binary. No Docker, no account, no cloud, no telemetry.

> **Early release.** v0.1.0 is usable and tested — and not complete. The
> [roadmap](/bellamente/roadmap) is the honest backlog.

## Install

Use npm:

```sh
npm install -g bellamente
bella doctor
bella
```

Or Python tooling:

```sh
pipx install bellamente
bella doctor
bella
```

For a one-shot Python run without installing a persistent `bella` command:

```sh
uvx bellamente doctor
```

The npm and PyPI packages install a tiny launcher. When no verified cache exists on supported
Windows x64 and Linux x64 machines, it downloads the matching GitHub release binary, verifies it
against `SHA256SUMS.txt`, and runs it.

You can also download a supported Windows x64 or Linux x64 binary from the
[latest release](https://github.com/The-Little-AI-Company/bellamente/releases/latest):

```sh
chmod +x bella-linux-x64        # Linux only; skip on Windows
./bella-linux-x64 doctor        # verifies DB, embedding model, ports, disk
./bella-linux-x64               # serves on 127.0.0.1:8080
```

## Zero config, really

- **No `.env`, no API key** on localhost. The first boot creates the embedded database
  (Postgres + pgvector compiled into the binary) and downloads the embedding model once.
- Set `BELLA_API_KEY` if you want a bearer key required anyway.
- Bind beyond localhost (`BELLA_HOST=0.0.0.0`) and a key is **auto-generated**, stored in the data
  dir (`apikey` file), and enforced. Exposure without auth is never the default.

## First memory in 30 seconds

```sh
curl -s localhost:8080/memories -H 'content-type: application/json' \
  -d '{"memories":[{"content":"Jeff prefers dark mode"}]}'

curl -s localhost:8080/search -H 'content-type: application/json' \
  -d '{"q":"what theme does Jeff like?"}'
```

Every response carries an `x-bella-trace-id` header — open the dashboard at
`http://127.0.0.1:8080/` to see exactly what was searched, what matched, at what score.

## Where to next

- [Using it](/bellamente/docs/using) — connect your chat client or agent, auto-capture, the dashboard.
- [API](/bellamente/docs/api) — every route, request and response shapes.
- [Config](/bellamente/docs/config) — every `BELLA_*` knob (all optional).
