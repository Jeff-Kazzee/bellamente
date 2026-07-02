# AGENTS.md — how to work in this repo

You are working on **Bellamente** ("Memoria Viva for your AI agents") — a local-first memory
service for AI agents: Bun + TypeScript + Hono, embedded PGlite (Postgres-in-WASM) + pgvector,
local embeddings, single-binary builds. The brand is Bellamente EVERYWHERE — copy, CLI (`bella`),
and machine identifiers. The pre-release working title was fully purged before v0.0.1 (Jeff's
directive, 2026-07-01): do NOT reintroduce it in any identifier, comment, doc, or test. Read this
whole file before changing anything.

## The one rule that outranks everything
**Never break a machine contract.** These are frozen until a migration plan says otherwise:
- Env vars: `BELLA_*`, read via `brandEnv()` (src/env.ts). Never read `process.env.BELLA_X`
  directly — always `brandEnv("X")`. There are NO legacy aliases.
- `x-bella-*` HTTP header names
- the data directory (`envPaths("Bellamente")` in src/paths.ts) — renaming it orphans user memories
- `service: "bellamente"` in `/health` (the doctor authenticity contract)
- `"bellamente.apikey"` localStorage key in dashboard/index.html
- API route paths and response field names
Brand copy (things a HUMAN reads: README, dashboard text, console/error messages, docs) says
Bellamente / `bella`. When unsure whether something is copy or contract: it's a contract — ask.

## Where the work is
- `docs/BACKLOG.md` — the prioritized work list. Every item has context, exact files, steps, and
  acceptance criteria. Pick the highest-priority unchecked item you can finish END-TO-END.
- `docs/CHANGES-*.md` — what already shipped and why. `docs/REBRAND-PLAN.md` — rebrand stages.
- `docs/` is gitignored (local-only, intentionally). Never `git add -f` anything in it.

## Workflow (no exceptions)
1. Branch off `dev` (`git checkout dev && git pull && git checkout -b <type>/<slug>`).
   NEVER commit to `prod` or directly to `dev`.
2. One logical change per commit. The commit message explains WHY, not just what.
3. Tests ship in the same commit as the change they cover.
4. Before EVERY commit, all four gates must pass:
   - `git diff --check`   (no whitespace damage)
   - `bunx tsc --noEmit`  (typecheck clean)
   - `bun test`           (every test green — no skips, no "unrelated failure" excuses)
   - `bun run build`      (binary compiles; emits ./bella)
5. Push the branch, open a PR into `dev`. Do not merge your own PR unless Jeff said to.
6. Update `docs/BACKLOG.md` (check the box, one-line outcome + date) in the same PR.

## Code conventions (copy the existing patterns, do not invent)
- SQL: tagged templates via the pg-shim ONLY (`sql\`...\``); nested `sql\`\`` fragments for
  conditional clauses. Never string-concatenate SQL. Inside `sql.begin(cb)` use ONLY the provided
  `tx` (awaiting the outer `sql` there deadlocks PGlite — documented in src/pg-shim.ts).
- Schema changes to shipped tables: append a numbered migration in `src/migrations.ts` (READ THE
  RULES in its header: append-only, idempotent, schema.sql updated in the same commit).
- Tests: PGlite `memory://` + `schemaForDim(EMBED_DIM)`; fixture vectors are small shapes
  ZERO-PADDED to `EMBED_DIM` (see test/memories.test.ts `pad()`); embed is a content-keyed fake.
  Give PGlite-heavy tests explicit timeouts (~20s); default 5s flakes under load.
- Env knobs are read PER-CALL (a function, not a module-level const) so tests can set/unset them.
  Careful: "invalid → fallback" and "out-of-range → clamp" are different semantics (see
  BACKLOG P2.14 before touching any of the clamp helpers).
- Comments only where the WHY is non-obvious. No new dependencies without checking
  `~/dev/.shared/deny-list-npm.json` (verified location) and `bun audit` first.
- New/changed user-visible strings say Bellamente/bella. New machine identifiers use `BELLA_*`;
  ask before inventing a new one (naming is a migration decision).

## What "done" means
The acceptance criteria in the BACKLOG item are met, all four gates pass, the behavior is proven
by a test (not by "it should work"), and anything you could not finish is written down in
BACKLOG with file:line pointers. If you are blocked or the code contradicts this file: STOP and
report — do not improvise around a contract.
