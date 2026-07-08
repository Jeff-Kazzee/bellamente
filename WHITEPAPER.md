# Bellamente: An Auditable, Local-First Memory Layer for AI Agents

**Jeff Kazzee**
The Little AI Company
jeffkazzee@gmail.com

Also available on the website: https://the-little-ai-company.github.io/bellamente/paper
License: MIT (same as the code).

*Draft v1 — 2026-07-07. Sections 6.2–6.3 describe planned experiments; only §6.1 reports measured results. Do not circulate as a claims-bearing preprint until §6.2 is executed.*

## Abstract

Long-term memory systems for LLM agents have converged on hosted extraction pipelines and knowledge graphs whose internal decisions — what was recalled, why, and what was silently rewritten — are largely opaque to the user whose life they describe. We present Bellamente, a memory layer designed around a single organizing principle: every memory operation must leave a durable, locally inspectable artifact. Bellamente runs entirely on the user's machine as one process: an embedded WASM Postgres (PGlite) with pgvector provides relational storage and vector search in-process; embedding models run locally with device-tiered fallback; and integration requires no SDK — an OpenAI-compatible proxy interposes on chat completions, granting the model memory access through an explicit tool-call round rather than silent prompt injection. Three mechanisms make the system auditable by construction: (1) *recall provenance* — every retrieval, including those initiated by the model mid-turn, is durably logged with candidate scores, latency, and the identity of each memory version served; (2) *non-destructive correction* — writes that supersede prior knowledge create versioned chains in which superseded versions remain first-class, queryable rows; and (3) *reversible forgetting* — deletion is a flagged, auditable state with a single explicit hard-delete escape hatch. We describe the architecture and its threat model, situate the design against extraction-pipeline, graph-based, and OS-paging memory systems, and propose an evaluation methodology that adds two probes absent from current practice: trace fidelity (does the audit log reproduce the injected context exactly?) and correction correctness (does a superseding fact reliably win over its ancestors?). Preliminary plumbing benchmarks through the real HTTP routes are reported; full LongMemEval-based evaluation is specified as the immediate next milestone.

**Keywords:** LLM agents, long-term memory, auditability, provenance, local-first software, retrieval-augmented generation

## 1 Introduction

An LLM agent that remembers its user accumulates exactly the kind of data — preferences, habits, relationships, corrections — that users are least willing to surrender to a hosted service and least able to verify in one. Contemporary memory systems ask for both surrenders at once. Hosted pipelines such as Mem0 [2] and Zep [3] centralize memory in managed services; product memories in ChatGPT and Claude are synthesized server-side under policies the user cannot inspect; and across nearly all systems, the *recall path* — which memories were considered, which were injected, at what score, and which version of a corrected fact was served — is either unlogged or observable only through external, typically hosted, tracing platforms. The memory-security literature has begun to formalize the resulting risks: memory poisoning and contamination attacks are difficult even to *detect* without an audit trail of what was written and what was recalled [22].

Bellamente is a systems answer to this gap. It is a deliberately small (~7 kLOC), single-process memory layer whose design goal is not maximal benchmark accuracy but *inspectability as an invariant*: no memory operation — write, dedup, supersede, recall, injection, forget, or capture — occurs without producing a durable artifact the user can read with SQL or a bundled dashboard, on hardware they control, with zero telemetry.

Our contributions:

1. **Recall provenance as a first-class storage object.** Every retrieval — API-initiated or model-initiated mid-turn — is durably recorded: the query, the candidate set with similarity scores, what fell below threshold, per-stage latency, and the exact memory versions injected into the model context (§5.4). To our knowledge no deployed memory system persists per-recall provenance in the memory store itself; the closest analogues log writes (Mem0's history API) or state (Memori's SQL store) but not recalls.
2. **A composition of non-destructive semantics in a local relational store.** Supersede chains (corrections create versions; ancestors remain queryable) and reversible forgetting adapt the bi-temporal invalidation insight of Graphiti/Zep [3] from a server-resident knowledge graph to an embedded, single-file Postgres — with the additional property that the entire lifecycle is visible to plain SQL (§5.3).
3. **Proxy-mediated memory with visible mechanics.** An OpenAI-compatible chat-completions proxy gives any client memory with a one-line base-URL change. Unlike prior transparent proxies that silently stuff context (e.g., Supermemory's Infinite Chat), Bellamente grants memory through an explicit tool-call round: the model *asks* to search, and that ask, its results, and the final injection are all in the trace (§5.5). Recall failure degrades to a memory-less answer rather than a failed turn.
4. **An evaluation design for auditable memory** including two system probes absent from current benchmark practice — trace fidelity and correction correctness — alongside LongMemEval [14] with published harness parameters, motivated by the reproducibility disputes that have undermined recent memory-system claims (§6).

## 2 Related Work

**Extraction-pipeline systems.** MemGPT [1] framed memory as OS-style paging between in-context and external storage, with the model self-editing memory via function calls. Mem0 [2] productionized LLM-arbitrated extraction (ADD/UPDATE/DELETE decisions per candidate fact) over vector and graph stores, and reports substantial latency and token savings versus full-context baselines on LoCoMo. Letta (the MemGPT lineage) exposes memory blocks in a development environment and has added background consolidation ("sleep-time compute") [24]. These systems increasingly *display* memory state; none durably logs the recall path.

**Graph and temporal systems.** Zep/Graphiti [3] contributes the bi-temporal model most relevant to us: facts carry validity intervals and are *invalidated, not deleted*, on contradiction. HippoRAG [5,6] and A-Mem [4] organize memory as association structures; MemOS [9] and MemoryOS [10] formalize lifecycle governance; MIRIX [11] types memory into six stores. Bellamente borrows the non-lossy correction insight and deliberately rejects graph infrastructure: its bet is that a relational schema with version chains, on an embedded database, buys inspectability worth more (for a personal, local deployment) than graph expressiveness.

**Local-first and SQL-native systems.** Memori runs in-process on SQLite and markets SQL auditability of memory *state*; txtai has long been embeddings-over-SQLite; MemOS shipped an on-device SQLite mode; GBrain syncs a markdown corpus into embedded Postgres via PGlite + pgvector with hybrid search — establishing that the PGlite substrate itself is not novel. Bellamente's distinction from all four is what sits atop the store: the proxy, per-recall provenance, and supersede/forget semantics.

**Proxy integration.** Supermemory's Infinite Chat interposes an OpenAI-compatible proxy that transparently extends context — hosted, with opaque injection. Hindsight [12] injects via LiteLLM callbacks. Bellamente appears to be the first *loopback-only, zero-telemetry* memory proxy, and the first in which injection is mediated by a logged tool-call round rather than silent prompt modification.

**Benchmarks and their pathologies.** LoCoMo [13] and LongMemEval [14] are the de facto standards; DMR [1,3] is saturated. Recent audits found nontrivial error rates in LoCoMo's answer key and high false-accept rates in LLM judging, and the public Mem0/Zep scoring dispute demonstrated that unpublished judge prompts and configuration make headline numbers irreproducible [23]. ConvoMem [16] adds the sobering control that full-context beats memory systems at small history scales. Our evaluation design (§6) is shaped by these failures: published harness, honest controls, and system-level probes that do not depend on LLM judges.

## 3 Design Goals and Threat Model

Bellamente assumes a single user on consumer hardware running local LLM servers (Ollama, LM Studio, llama.cpp, vLLM) and/or MCP-capable agent tools. Design goals, in priority order: (G1) every memory operation leaves a durable local artifact; (G2) no network egress of memory content, ever — the server binds 127.0.0.1 by default and contains no telemetry; (G3) corrections and deletions are non-destructive by default; (G4) integration requires no SDK or client code changes; (G5) the whole system is one process and one binary — no Docker, no external database server, no model server for embeddings.

The threat model addresses: curious or compromised *remote* services (excluded by construction — G2); silent memory corruption (dimension/model-identity mismatches fail fast at boot; versioning prevents silent overwrite); secret leakage into the store (two independent redaction layers; a sensitive-content exclusion list gates auto-capture); and post-hoc unaccountability (G1). It explicitly does *not* defend against a hostile local process with filesystem access, which can read the data directory directly — a limitation shared with all local-first tools and documented in-tree. Cross-origin abuse of the loopback server (DNS rebinding/CSRF) was identified in a 2026-07 external audit; the mitigation (Host/Origin validation) is scheduled for the next release.

## 4 Architecture Overview

One Hono HTTP application and two singletons — `sql` (embedded Postgres) and `embed` (local embedding function) — shared by every feature as `ctx = {sql, embed}`. Route modules implement memories, documents, search, profile, inspection, export/import, error reporting, and the chat-completions proxy; an MCP server (stdio) exposes nine tools over the same context. The compiled artifact is a single binary embedding the database engine, the embedding runtime, the dashboard, and the migration history.

## 5 System Design

### 5.1 Embedded relational storage

PGlite (Postgres compiled to WASM) with pgvector runs in-process; the schema is plain SQL with append-only migrations applied at boot. A 142-line shim exposes a tagged-template interface compatible with the porsager `postgres` client, in which nested query fragments compose through a shared parameter accumulator so placeholder numbering is correct by construction; the identical tuned SQL therefore runs against embedded WASM Postgres or an external `DATABASE_URL` Postgres without translation. Full-text search and vector search are fused with reciprocal rank fusion, merged by rank rather than score.

### 5.2 Device-tiered local embeddings

Capable machines run multilingual-e5-small (384-d) in a WASM worker; low-RAM machines are detected proactively and fall back to a pure-TypeScript static Model2Vec model rather than risking an uncatchable WASM out-of-memory abort. The chosen model and dimension are pinned per data directory, and boot-time guards fail fast on both dimension mismatch and same-dimension model-identity mismatch — a silent-recall-corruption class that vector stores generally do not check.

### 5.3 Memory lifecycle: supersede chains and reversible forgetting

Writes pass through a single choke point that deduplicates exact matches and *supersedes* near-duplicates: the new content becomes version *n+1* of a chain whose prior versions remain stored, queryable, and marked with transaction-frozen validity timestamps (guaranteeing gapless windows). Version races between concurrent writers are resolved flip-before-insert with a per-item conflict action, backed by a unique partial index on the latest-version flag. Edits via PATCH create versions rather than mutating rows. Forgetting sets an audited, reason-carrying flag on the whole chain and is reversible; hard DELETE is the only physical-removal path and is labeled as such in the API. The result is that "what did the system believe about X on date D, and when did that change?" is a SQL query.

### 5.4 Recall provenance

Every search — whether from the search API, the proxy's tool round, MCP tools, or auto-capture's dedup pass — writes a durable trace: query text, embedder identity, candidate memories with similarity scores (including those below the acceptance floor), stage latencies, and, for proxy turns, which memory versions were injected into the final model call, correlated to the client via an `x-bella-trace-id` response header. Traces are rows in the same database as the memories, inspectable via API, dashboard, or SQL. This converts two classically unanswerable questions — "why did the agent say that?" and "was my memory store poisoned?" — into log lookups [22].

### 5.5 Proxy-mediated integration via an explicit tool round

Clients change one base URL. On a chat completion, the proxy forwards the request to the configured upstream with a memory-search tool exposed; if the model invokes it, the proxy executes retrieval locally, re-invokes the upstream with results, and returns (or streams) only the final answer. The mechanism is identical for buffered and streamed requests: a streaming classifier buffers server-sent events only until the turn's nature (answer, external tool call, memory tool call) is decided, with idle timeouts, a runaway cap, and tolerance for deltas that omit tool-call indexes. Design consequences: the model's *decision* to consult memory is itself part of the trace (unlike silent context-stuffing proxies), and any retrieval failure degrades the turn to a memory-less answer rather than an error.

### 5.6 Auto-capture with redaction

The proxy optionally captures durable first-person facts from conversation. Candidates pass a sensitive-content exclusion list (credentials, financial, medical categories are never stored) and two redaction layers, then the standard dedup/supersede path; every capture event is traced and reversible. An optional distillation pass runs through the *same local upstream* (never a cloud call) and fails open to heuristic extraction — a distillation failure cannot lose a capture.

## 6 Evaluation

### 6.1 Preliminary: end-to-end plumbing benchmarks (measured)

A deterministic harness drives the real HTTP routes (`POST /memories`, `/documents`, `/search`) against embedded PGlite with a deterministic-hash embedder (seed 20260702, 110 queries): memories R@1/R@10/MRR = 84.1%/100.0%/0.920; documents 100/100/1.000; hybrid 100/100/1.000; exact-vs-ANN-route delta@10 = 0.0% at fixture scale. We report these as *plumbing verification* — they establish that the retrieval path, fusion, and thresholds behave as specified end-to-end, not that retrieval quality is competitive; the fixture corpus is too small to engage HNSW, and document/hybrid rows are ceiling checks. A separate 50k-row probe verifies ANN plan and row-fill behavior at scale; ANN recall-loss quantification is open work.

### 6.2 Planned: benchmark evaluation (specified, not yet run)

Primary: LongMemEval [14] through the proxy path, reporting the per-ability breakdown (information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention) — knowledge updates and abstention being the abilities our correction semantics should differentially help. Secondary: LoCoMo [13] with its documented answer-key and judging caveats stated. Controls, per ConvoMem's finding [16]: a full-context baseline and naive RAG over transcript chunks, plus at least one extraction system (Mem0) and one graph system (Graphiti) self-hosted. Protocol: published judge model and prompt, fixed seeds, ≥3 runs, confidence intervals; p50/p95 added proxy latency, tokens injected per request, and total token cost versus full-context; all on two consumer hardware tiers matching the embedding fallback boundary.

### 6.3 Planned: audit-specific probes (the novel section)

**Trace fidelity.** For every evaluated turn, reconstruct the injected context from the trace alone and compare byte-for-byte with what the upstream actually received (recorded at a test shim). Metric: fraction of turns with exact reconstruction. This measures the paper's central claim directly; no surveyed system reports it.

**Correction correctness.** Seed fact F₁; supersede with contradicting F₂; measure (a) recall serves F₂ not F₁, (b) after forgetting F₂, neither is served, (c) after undo, F₂ is served again — across paraphrase distances and chain depths. Complements LongMemEval's knowledge-update slice with a mechanism-level test.

**Capture safety.** Adversarial corpus of secret-bearing and sensitive-category utterances; metric: zero stored secrets (verified by scanning the store), plus capture precision/recall on a labeled benign corpus.

## 7 Limitations

Single-user, single-org by design; the schema's dormant multi-tenancy is unused. The trace store grows without bound (compaction policy is open work) and traces themselves contain conversation text — an inspectability/retention trade-off users must own (they can, because it is their disk). Provider coverage is OpenAI-shape only (Anthropic/Google shapes are roadmap). Embedding quality on the low-RAM tier is measurably weaker; the tier is pinned and disclosed but not yet quantified in retrieval terms. No macOS builds yet. The evaluation in §6.2–6.3 is specified but not executed; this draft makes no comparative quality claims.

## 8 Conclusion

Bellamente demonstrates that a memory layer can be auditable by construction rather than by external tooling: one process, an embedded SQL store, versioned corrections, reversible forgetting, and — most distinctively — durable per-recall provenance, including the model's own decisions to consult memory through a proxy-mediated tool round. None of its individual mechanisms is unprecedented; the claim is the composition, and that the composition is the precondition for trustworthy personal agent memory. The immediate next milestone is the evaluation of §6.2–6.3, whose audit-specific probes we hope other memory systems adopt regardless of this system's fortunes.

## References

*Confirmed against arXiv abstract pages except where flagged.*

[1] C. Packer, S. Wooders, K. Lin, V. Fang, S. G. Patil, I. Stoica, J. E. Gonzalez. MemGPT: Towards LLMs as Operating Systems. arXiv:2310.08560, 2023.
[2] P. Chhikara, D. Khant, S. Aryan, T. Singh, D. Yadav. Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory. arXiv:2504.19413, 2025.
[3] P. Rasmussen, P. Paliychuk, T. Beauvais, J. Ryan, D. Chalef. Zep: A Temporal Knowledge Graph Architecture for Agent Memory. arXiv:2501.13956, 2025.
[4] W. Xu, Z. Liang, et al. A-MEM: Agentic Memory for LLM Agents. arXiv:2502.12110, 2025.
[5] B. J. Gutiérrez, Y. Shu, Y. Gu, M. Yasunaga, Y. Su. HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models. arXiv:2405.14831, NeurIPS 2024.
[6] B. J. Gutiérrez, Y. Shu, W. Qi, S. Zhou, Y. Su. From RAG to Memory: Non-Parametric Continual Learning for Large Language Models. arXiv:2502.14802, 2025.
[7] J. S. Park, J. C. O'Brien, C. J. Cai, M. R. Morris, P. Liang, M. S. Bernstein. Generative Agents: Interactive Simulacra of Human Behavior. arXiv:2304.03442, UIST 2023.
[8] W. Zhong, L. Guo, Q. Gao, H. Ye, Y. Wang. MemoryBank: Enhancing Large Language Models with Long-Term Memory. arXiv:2305.10250, AAAI 2024.
[9] Z. Li et al. MemOS: A Memory OS for AI System. arXiv:2507.03724, 2025.
[10] J. Kang et al. Memory OS of AI Agent. arXiv:2506.06326, EMNLP 2025.
[11] Y. Wang, X. Chen. MIRIX: Multi-Agent Memory System for LLM-Based Agents. arXiv:2507.07957, 2025.
[12] C. Latimer, N. Boschi, A. Neeser, C. Bartholomew, G. Srivastava, X. Wang, N. Ramakrishnan. Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects. arXiv:2512.12818, 2025.
[13] A. Maharana, D.-H. Lee, S. Tulyakov, M. Bansal, F. Barbieri, Y. Fang. Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo). arXiv:2402.17753, ACL 2024.
[14] D. Wu, H. Wang, W. Yu, Y. Zhang, K.-W. Chang, D. Yu. LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. arXiv:2410.10813, ICLR 2025.
[15] J. Xu, A. Szlam, J. Weston. Beyond Goldfish Memory: Long-Term Open-Domain Conversation. arXiv:2107.07567, ACL 2022.
[16] E. Pakhomov, E. Nijkamp, C. Xiong. Convomem Benchmark: Why Your First 150 Conversations Don't Need RAG. arXiv:2511.10523, 2025.
[17] Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions (MemoryAgentBench). arXiv:2507.05257, 2025.
[18] Z. Zhang, X. Bo, C. Ma, R. Li, X. Chen, Q. Dai, J. Zhu, Z. Dong, J.-R. Wen. A Survey on the Memory Mechanism of Large Language Model based Agents. arXiv:2404.13501, 2024.
[19] Y. Wu et al. From Human Memory to AI Memory: A Survey on Memory Mechanisms in the Era of LLMs. arXiv:2504.15965, 2025.
[20] Y. Hu, S. Liu, Y. Yue, G. Zhang, et al. Memory in the Age of AI Agents. arXiv:2512.13564, 2025.
[21] P. Du. Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers. arXiv:2603.07670, 2026.
[22] A Survey on Long-Term Memory Security in LLM Agents: Attacks, Defenses, and Governance Across the Memory Lifecycle. arXiv:2604.16548, 2026.
[23] Zep. "Lies, Damn Lies, Statistics: Is Mem0 Really SOTA in Agent Memory?" blog.getzep.com, 2025; and the associated re-scoring dispute (github.com/getzep/zep-papers issue #5).
[24] K. Lin, C. Snell, Y. Wang, C. Packer, S. Wooders, I. Stoica, J. E. Gonzalez. Sleep-time Compute: Beyond Inference Scaling at Test-time. arXiv:2504.13171, 2025. See also Letta, "Sleep-time Compute," letta.com/blog, 2025.
[25] ElectricSQL. PGlite: Embeddable Postgres. pglite.dev, 2024–2026.
[26] Supermemory. "Infinite Chat: the transparent context-extension proxy." supermemory.ai/docs, 2025–2026.
[27] G. Tan. GBrain: a markdown-first local brain on embedded Postgres. github.com/garrytan/gbrain, 2026.
[28] GibsonAI. Memori: an open-source SQL-native memory engine for AI agents. 2025.
