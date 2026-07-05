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
