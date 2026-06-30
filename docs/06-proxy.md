# 06 - Proxy (OpenAI-compatible interceptor)

## Purpose
Port of Cs6: transparent LLM proxy that injects memory + profile.

## Tool definition (verbatim - must match exactly)
- name: supermemoryToolSearch
- description begins: ***CRITICAL: YOU CAN ONLY MAKE ONE TOOL CALL*** - Search through the
  user's personal memories, documents, and stored information ... include all your queries in
  the queries array in ONE call ...
- parameters: { queries: array<string>, minItems 1, maxItems 5 }, required ["queries"].

## Flow
1. Resolve user from x-sm-user-id header / body.user / ?userId.
2. If request already has tool_result content -> pass-through; set
   x-supermemory-tool-passthrough=true, x-supermemory-context-modified=false.
3. Detect provider by hostname/body shape: anthropic / google / openai (port of Gs6).
4. Inject tool: if (!tools.some(t => t.name === NAME)) tools.unshift(tool).
5. Inject profile (Spec 07) into system prompt.
6. Conversation mgmt: token budget 3000, batch + cache per-batch summaries
   (key summary:{user}:{hash}), prepend "Here's what we spoke about earlier:".
7. Forward; intercept supermemoryToolSearch tool_calls; run searchMemories for <=5 queries
   (10s race); dedup -> <=25; inject as tool_result; re-invoke upstream.
8. Response headers: x-supermemory-tool-intercept, x-supermemory-search-tool-results=<count>,
   x-supermemory-conversation-id.

## Provider routing (upstream URLs)
openai api.openai.com, anthropic api.anthropic.com, google generativelanguage/aiplatform,
plus openrouter / deepinfra / groq / cloudflare gateway (optional in v1).

## Acceptance
- An OpenAI SDK pointed at minimem gets memory-grounded answers without code changes.
- Passthrough mode never double-injects.
