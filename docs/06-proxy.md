# 06 - Proxy (OpenAI-compatible interceptor)

## Purpose
Transparent LLM proxy that injects a memory-search tool + user context. Clean-room: our own
tool name, header names, and wording (no third-party identifiers or verbatim text).

## Tool definition (ours)
- name: searchMemory
- description: "Look up the user's saved memories and documents whenever you need context you do
  not already have ... Call this at most once per turn: put every question into the `queries`
  array in a single call instead of invoking the tool repeatedly."
- parameters: { queries: array<string>, minItems 1, maxItems 5 }, required ["queries"].

## Flow
1. Resolve user from x-minimem-user-id header / body.user / ?userId.
2. If request already has tool_result content -> pass-through; set
   x-minimem-tool-passthrough=true, x-minimem-context-modified=false.
3. Detect provider (anthropic / google / openai) by hostname/body shape.
4. Inject tool: if (!tools.some(t => t.name === "searchMemory")) tools.unshift(tool).
5. Inject profile (Spec 07) into the system prompt.
6. Conversation mgmt: token budget, batch + cache per-batch summaries.
7. Forward; intercept searchMemory tool_calls; run searchMemories for <=5 queries (10s race);
   dedup -> <=25; inject as tool_result; re-invoke upstream.
8. Response headers: x-minimem-tool-intercept, x-minimem-search-results, x-minimem-conversation-id.

## Status
Tool + profile injection wired (M1). Upstream forward + tool-call interception = M3 (TODO).

## Acceptance
- An OpenAI SDK pointed at minimem gets memory-grounded answers without code changes.
- Passthrough mode never double-injects.
