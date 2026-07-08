# Contributing to Bellamente

Thanks for helping. Bellamente is MIT-licensed and PRs are welcome. This guide is short on purpose.

## Setup

Bellamente runs on [Bun](https://bun.sh).

```sh
bun install
bun run dev      # zero-config local server on http://127.0.0.1:8080
bun run ci       # the full gate: typecheck, tests + coverage, smoke, binary build, website
```

## The flow

- **Branch off `dev`** (never `prod`). One focused change per PR.
- Open your PR **into `dev`**. `prod` is the release branch — maintainers promote `dev → prod` and cut releases.
- **Behavior-tests-first**: new or changed behavior ships with a test, and `bun run ci` must be green.
- Keep the machine contract stable — `BELLA_*` env vars, `x-bella-*` headers, route paths, and response
  shapes. If you must change one, call it out in the PR.
- Update docs if the change is user-facing.

The PR template walks you through the rest.

## Privacy contract (important)

Bellamente's whole promise is **inspect and trust**. Two rules hold everywhere:

- **Capture metadata, never content.** Logs and error output are content-free by construction
  (see `src/redact.ts` and `src/observe.ts`). A memory write redacts credentials before storage
  (`src/secret-scan.ts`).
- **Never phone home.** Nothing leaves the machine unless the user explicitly does it.

If your change touches user-content handling, logging, error output, or runtime behavior, say so in the PR's
**Privacy / behavior changes** section.

## Show your work (optional): AI session summary

Built your change with an AI coding agent (Claude Code, Codex, Cursor, …)? You can **optionally** attach a
short, privacy-safe summary of your session to the PR — what you did, the key decisions, which files you
touched, what you verified, and roughly how long it took. It helps a maintainer judge the **intent and effort**
behind a change (and whether it's likely to work) without reading every line — which matters a lot when a
project gets more PRs than anyone can review by hand.

It's **redacted by construction** — no secrets, no file contents, no personal conversation; just the shape of
the work. This is the same "capture metadata, never content" principle the product itself follows. Two ways to
make one:

- **With Claude Code**: run the bundled skill — `/pr-summary` — and it generates the redacted markdown for you
  to paste into the PR's *How this was built* section.
- **By hand**: write a few bullets in the same spirit.

Entirely optional. A great PR needs none of this — it's just a way to make effort visible when you want to.
