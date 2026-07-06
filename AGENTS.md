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

## Behavior tests FIRST (Jeff's rule, 2026-07-02 — no exceptions)
Every new epic, feature, or capability starts by writing the behavior tests, BEFORE the
implementation:
1. Read the relevant spec (docs/00–10, PRD, BACKLOG item) and enumerate the promised behaviors —
   including error/degradation paths, not just the happy path.
2. Write them as failing tests (the test names ARE the spec). Commit message may land them together
   with the implementation, but the tests must be written first and must fail before the fix.
3. A feature without behavior tests does not merge. Ever. `bun run test` runs the full suite and
   enforces the aggregate coverage floor mechanically — it FAILS below the ratchet.
4. The floors are a RATCHET: when coverage rises, raise the floor in the same PR. Never lower them.
   Long-term target is 1.0; code that genuinely cannot be unit-tested (WASM embed worker, real
   model downloads, `Bun.serve` listen) must instead be covered by the release smoke checklist and
   named in the PR as such — silence is not an option.
This exists because review passes kept finding capabilities that were coded but never wired or
never worked (see docs/CHANGES-2026-07-01.md #4, #6): a behavior without a test demanding it
does not reliably exist.

## Model roles + spec-driven handoffs (Jeff, 2026-07-02)
Multiple models work in this repo. Each has a lane; the SPEC is the handoff artifact between them.
- **Codex / GPT (extra-high reasoning): PRIMARY IMPLEMENTER.** Backend features and parity items,
  implemented FROM A SPEC in `docs/specs/` — never from a one-line prompt. Follow the spec's
  acceptance tests exactly; if the spec is ambiguous or the code contradicts it, STOP and flag —
  do not improvise around it.
- **Claude Fable: SPEC AUTHOR + FIXER + FINAL JUDGE.** Writes specs for complex tasks, runs
  adversarial review on substantial PRs WHEN AVAILABLE, fixes the problems and fills the gaps other
  models leave, owns architecture/tradeoff calls. Do NOT burn Fable on mechanical feature grinding —
  that is Codex's lane (usage economics: Fable is scarce, Codex is the workhorse). **Fable is not
  always available, so the review + merge gate must NOT depend on Fable specifically — it is a
  PROCESS an independent reviewer sub-agent can run (see Workflow §5).**
- **Claude Opus: UI + mid-complexity implementation.** Dashboard, website, design-system work
  (the La Macchina system — see dashboard/index.html tokens + website/), and feature work when it
  carries a spec.
- **Any model, before starting a task:** read this file, the relevant `docs/specs/SPEC-*.md`, and
  `docs/HANDOFFS.md` (the protocol + spec template + verification ladder). A complex task with no
  spec yet gets a spec FIRST (by Fable) — implementation without a spec is only for small,
  well-bounded items whose BACKLOG entry already carries testable acceptance criteria.
- Every model obeys the Behavior-tests-FIRST law and the four gates. No exceptions by model.
- Product line to hold (docs/BACKLOG.md "Positioning guardrails"): parity with Supermemory on
  capability, but the IDENTITY is "memory you can inspect and trust" — local-first single binary,
  trace-everything, correction/versioning UI, never phones home. We are not building a clone.

## Workflow (no exceptions)
1. Branch off `dev` (`git checkout dev && git pull && git checkout -b <type>/<slug>`).
   NEVER commit to `prod` or directly to `dev`.
2. One logical change per commit. The commit message explains WHY, not just what.
3. Tests ship in the same commit as the change they cover (written first — see above).
3b. DOCS LAW (Jeff, 2026-07-02): any user-facing behavior change updates the matching docs page
   (website/src/pages/docs/*.md) in the SAME PR. The repo Markdown IS the website — GitHub Pages
   rebuilds it on every `prod` push, so repo and site cannot drift. test/website.test.ts pins the site
   structure; ```prompt fences are agent-paste blocks (labeled + copy-buttoned by DocsLayout).
4. Before EVERY commit, `bun run ci` must pass locally:
   - frozen dependency install and moderate-or-higher dependency audit
   - typecheck, full test suite with aggregate coverage gate, release smoke, binary build
   - package/release artifact gate, website build
   - `git diff --check` for whitespace damage
5. Push the branch, open a PR into `dev`. MERGE DISCIPLINE (Jeff, 2026-07-02; review decoupled from
   Fable 2026-07-05): a substantial PR merges only after (a) an ADVERSARIAL REVIEW whose findings are
   verified against the real code and fixed, (b) CI green on Actions, and (c) the change DOGFOODED —
   proven by actually using it, not just by tests. The review is a PROCESS, not a person: Fable runs it
   when available, otherwise an INDEPENDENT REVIEWER SUB-AGENT runs the same adversarial pass — do NOT
   block work on Fable being around. Implementers do NOT self-merge unreviewed or self-close issues,
   and NEVER merge while review follow-ups are still open (PR #79 shipped mid-review without a fix —
   PR #84 repaired it). Jeff directs merges/closes; release surfaces (tags, releases, dev->prod,
   deploys) are Jeff-only.
6. Update `docs/BACKLOG.md` (check the box, one-line outcome + date) in the same PR.

## Platform: Windows dev machine, Linux CI (line endings + WSL)
This repo is developed on a **Windows** machine, but CI (GitHub Actions) and the canonical test/build
run on **Linux**. Two consequences that bite if ignored:
- **Line endings are LF, enforced by `.gitattributes` (`* text=auto eol=lf`).** Do NOT let an editor
  or tool rewrite files as CRLF — it makes a branch look dirty for no real change and can fail the
  `git diff --check` gate. Tracked text files are LF; keep them that way. If a branch shows spurious
  whole-file diffs, that's a CRLF flip — re-save as LF or `git add --renormalize .`, don't commit it.
- **Verify Linux behavior on WSL before trusting a green Windows run.** Windows-local coverage reads
  ~1% lower than Linux and some path/process/permission behaviors differ; **GitHub Actions (Linux) is
  the canonical gate.** For anything platform-sensitive (paths, spawned processes, file perms,
  coverage), reproduce under WSL (Ubuntu) so you're testing what CI tests, not just Windows.

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

## Current release truth

- Current PUBLISHED release: `v0.0.2` (GitHub + npm + PyPI, all consistent). A `v0.0.3` train is
  staged on `dev`; this line changes only when the GitHub release actually exists.
- Source repo: `https://github.com/The-Little-AI-Company/bellamente`.
- Public site/docs: `https://the-little-ai-company.github.io/bellamente/`.
- Package installs: `npm install -g bellamente`, `pipx install bellamente`, or one-shot `uvx bellamente doctor`.
- GitHub release assets must exist before a `prod` deploy points public copy at that version.
- Current public direct binaries are Windows x64 and Linux x64 only until more OS builds have a real
  test pass. Release ASSETS must match this copy: never upload binaries for an OS the copy doesn't
  claim (the untested v0.0.2 darwin binaries were withdrawn 2026-07-05 for exactly this).

## Copy-alignment law (2026-07-05, after the drift audit)

Copy drifts in BOTH directions; underselling is also a truth bug. These checks are part of "done":
- This file's "Current release truth" states the PUBLISHED version, never the staged train version.
  README/ROADMAP on `dev` may run one version ahead during a release train; this section may not.
- ROADMAP.md and its mirrors (website/src/pages/roadmap.astro, website/public/llms-full.md) move a
  feature to "Now" in the SAME PR that ships it — a roadmap listing shipped features as upcoming
  breaks the "if it's on the roadmap, it doesn't exist" promise. All three surfaces change together.
- README's API list and architecture map include every shipped route; check them in any PR that adds
  or renames a route module.
