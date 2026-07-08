---
name: pr-summary
description: Generate a privacy-safe, redacted markdown summary of the current AI coding session — what was done, key decisions, files touched, verification, and time spent — for optionally attaching to a Bellamente pull request to show effort and intent. Use when the user asks to summarize the session for a PR, to "show my work", or mentions pr-summary / effort summary / session summary.
---

# PR session summary

Produce a short, **privacy-safe** markdown summary of THIS coding session, suitable for pasting into a pull
request under the template's *How this was built* section. The goal is to let a maintainer see the **effort and
intent** behind the change — not to reproduce the transcript.

## Hard privacy rules (redacted by construction)

Never put any of these in the summary. When in doubt, leave it out — this mirrors Bellamente's own
"capture metadata, never content" contract.

- **Secrets / credentials** — API keys, tokens, passwords, private keys, connection strings, `DATABASE_URL`.
  If any appeared in the session, never reproduce them; refer to them abstractly ("configured the API token").
- **Raw file contents or the diff.** Summarize what changed; don't paste code. A 1–3 line illustrative snippet
  is OK only if it contains no secret and nothing the author wouldn't publish.
- **Absolute filesystem paths that contain a username / home directory.** Use repo-relative paths
  (`src/foo.ts`), never `C:\Users\<name>\…` or `/home/<name>/…`.
- **Personal or unrelated conversation** — anything not about this change.

## What to include

Fill this template from the session. Keep it tight; bullets over prose.

```md
### 🤖 How this was built

**Agent:** <Claude Code / Codex / …> · **Time on this change:** <~Xh Ym> · **Turns:** <approx>

**What I did**
- <2–6 bullets: the actual work, in plain language>

**Key decisions**
- <notable choices / tradeoffs, and why>

**Files touched**
- `path/to/file` — <one line: what changed>

**How I verified it**
- <tests added/run, `bun run ci` result, manual checks / dogfood>

**Known gaps / follow-ups**
- <anything deferred, or "none">
```

## Estimating time + turns

- Estimate **time on this change** from the session's first/last timestamps if you can see them; otherwise give
  an honest rough estimate and mark it with `~`. Count only work on THIS change, not tangents.
- **Turns** = approximate number of user↔agent exchanges (optional; drop it if unknown).
- Be honest. An inflated effort number defeats the entire purpose — reviewers use this to build trust.

## Steps

1. Identify the actual change being PR'd (ignore tangents and abandoned attempts).
2. Draft the summary from the template above.
3. **Re-read it against the privacy rules** and strike anything that violates them.
4. Output ONLY the final markdown block, ready to paste — no commentary around it.
