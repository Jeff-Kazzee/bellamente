<!-- Keep PRs small and focused: one job per PR. Target `dev` (never commit to `prod`). -->

## What & why
<!-- One or two sentences: what changed and the problem it solves. -->

## Changes
<!-- Bullet the key changes. -->
-

## Privacy / behavior changes
<!-- Any change to user-content handling, logging, error output, or runtime behavior a reviewer must know.
     "None" is a valid answer. Remember the contract: capture metadata, never content; no phone-home. -->
None

## Verification
- [ ] `bun run ci` green locally (or note which gate is pending / platform diff)
- [ ] Behavior-tests-first: new or changed behavior is covered by a test
- [ ] No machine-contract change (`BELLA_*` env, `x-bella-*` headers, route paths / response shapes) — or it is called out above
- [ ] Docs updated if user-facing

## Deferred / out of scope
<!-- Anything intentionally left for a follow-up, so it is not mistaken for an omission. -->

## How this was built (optional)
<!--
Built this with an AI coding agent? You can OPTIONALLY attach a privacy-safe summary of your session — what
you did, key decisions, files touched (names only), what you verified, and time spent — so a reviewer can see
the effort + intent behind the change without reading every line. It's redacted by construction: no secrets,
no file contents, no personal chat. Generate one with the `/pr-summary` skill (see CONTRIBUTING.md), or write
a few bullets by hand. Entirely optional — delete this section if you'd rather not include it.
-->
<details>
<summary>🤖 AI session summary</summary>

_paste the redacted summary here_

</details>
