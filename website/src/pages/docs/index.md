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

> **Early release.** v0.0.1 is usable and tested — and not complete. The
> [roadmap](/roadmap) is the honest backlog.

## Install

Download the binary for your platform from the
[latest release](https://github.com/Jeff-Kazzee/bellamente/releases/latest), then:

```sh
chmod +x bella-linux-x64        # macOS/Linux only; skip on Windows
./bella-linux-x64 doctor        # verifies DB, embedding model, ports, disk
./bella-linux-x64               # serves on 127.0.0.1:8080
```

Verify the download with `SHA256SUMS.txt` from the same release page.

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

- [Using it](/docs/using) — connect your chat client or agent, auto-capture, the dashboard.
- [API](/docs/api) — every route, request and response shapes.
- [Config](/docs/config) — every `BELLA_*` knob (all optional).
