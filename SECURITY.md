# Security Policy

## Supported versions

Bellamente is pre-1.0. Only the latest `0.1.x` release is supported with security fixes — there is no
backport policy yet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repo: go to the **Security** tab →
**Report a vulnerability**. That opens a private advisory only the maintainer can see, which is safer
than filing a public issue for anything sensitive. Please don't email — there is no dedicated security
address, and a public report is the one thing we'd ask you not to do until it's fixed.

## What to expect

This is a small project run by one maintainer, in the open, on the side. Expect an acknowledgment
within a few days, not hours. Fix timelines depend on severity and my availability — I'll say so plainly
in the advisory thread rather than promise a number I can't keep.

## Scope

Bellamente is a local-first tool: the server binds to `127.0.0.1` by default and sends no telemetry.
The threat model is documented in [`src/auth.ts`](src/auth.ts) and in the
[whitepaper, §3](WHITEPAPER.md#3-design-goals-and-threat-model). In short, it defends against curious or
compromised remote services and against silent, unaccountable memory corruption — not against a hostile
local process with filesystem access. Anyone who can already read your machine's disk can read the data
directory directly; that's out of scope, as it is for every local-first tool.

In scope: anything that lets a remote party read, write, or corrupt memory data without the operator's
consent — including cross-origin abuse of the loopback server (see the DNS rebinding note in
[whitepaper §3](WHITEPAPER.md#3-design-goals-and-threat-model)), auth bypass, and secret-redaction
failures.

Thank you for reporting responsibly.
