# Supersede-threshold benchmark — evidence & recommendation

_Generated 2026-07-06 on Windows 11 (dev box), e5 quality tier (`Xenova/multilingual-e5-small`, q8, 384-dim)._
_Reproduce: `BELLA_EMBED_TIER=quality bun run scripts/bench-supersede.ts` · math test: `bun test test/bench-supersede.test.ts`._

## What this measures

When a memory is written, `writeMemory` (`src/memories.ts:141-185`) finds the single nearest current-latest
memory in the same org+space by cosine and, if `cosine >= τ` (`DEFAULT_SUPERSEDE_THRESHOLD`, `memories.ts:31`
= **0.95** for e5/wasm, 0.98 for static), **collapses** the new write onto it (new version, old flipped
`is_latest=false`). That τ has never been measured. `scripts/bench-supersede.ts` mirrors this exact
sequential nearest-neighbor cascade in-memory (vectors are L2-normalized, so dot == cosine, same metric as
production) over a labeled dataset whose labels were **independently vetted** before use.

Two populations are in tension:
- **should-MERGE** — a fact updated/corrected over time (the update should supersede the old value).
- **should-NOT-merge** — structurally similar but semantically distinct facts (must each survive).

## Findings (e5 only)

### 1. The two populations OVERLAP — no single scalar threshold can separate them. (robust)

| population | n | min | median | max |
|---|---:|---:|---:|---:|
| should-MERGE (correction update↔prior) | 13 | 0.7743 | 0.9224 | 0.9609 |
| should-NOT-merge (nearest different fact) | 51 | 0.8163 | 0.8591 | 0.9862 |

Corrections run **0.77–0.96**; distinct-fact confusers run **0.82–0.99**. They overlap through the whole
0.82–0.96 band, and the highest confuser (0.986) sits **above** the highest correction (0.961). Any single
scalar can only trade one error for the other. (Robust: holds even without the node group — corrections still
reach 0.77 and non-node confusers sit in the low-0.9s.)

### 2. The silent over-merge is 100% concentrated in ENUMERATED near-clones — not same-topic facts. (robust)

Every distinct-fact pair sitting ≥ 0.95 is a `Server node N` ↔ `Server node M` pair (10 of 10). At τ=0.95:

| distinct group | ideal facts | survived | lost |
|---|---:|---:|---:|
| node (Server node 1..5) | 5 | 1 | **4** |
| config (MAX_RETRIES / MAX_TIMEOUT / …) | 4 | 4 | 0 |
| allergy (Sarah / Tom / Rachel) | 3 | 3 | 0 |
| meeting (Alice / Bob / Carol) | 3 | 3 | 0 |
| flight (Denver / Boston / Seattle) | 3 | 3 | 0 |
| salary (same $ amount, different person) | 3 | 3 | 0 |

e5 keeps same-topic distinct facts apart by subject/key (config keys, people's salaries, meetings all survive
intact). The dangerous **silent** data-loss is specifically **templated enumerations** (`node 1..N`) — exactly
the originally-flagged dogfood case. This is a *pattern*, not a broad "similar facts collapse."

### 3. Raising the scalar "a little harder" buys nothing until it ≈ disables the feature. (robust — answers the steer)

| τ | correct collapses | FALSE collapses | missed corrections | facts lost (over-merge) | survivors / ideal |
|---:|---:|---:|---:|---:|---:|
| 0.93 | 5 | 4 | 8 | 4 | 42 / 38 |
| 0.94 | 4 | 4 | 9 | 4 | 43 / 38 |
| **0.95** | **3** | **4** | **10** | **4** | **44 / 38** |
| 0.96 | 1 | 4 | 12 | 4 | 46 / 38 |
| 0.97 | 0 | 4 | 13 | 4 | 47 / 38 |
| 0.98 | 0 | 1 | 13 | 1 | 50 / 38 |
| 0.99 | 0 | 0 | 13 | 0 | 51 / 38 |

- Over-merge is **flat at 4 from 0.93→0.97**, dropping only at 0.98. So **0.96 and 0.97 are strictly
  dominated** — no over-merge benefit, strictly more missed corrections. The hypothesized "just go to 0.96"
  buys literally nothing.
- The node clones sit at **0.97–0.99**, so the only τ that stops them is ≥ 0.98 — but at 0.98 **auto-supersede
  is effectively off** (correct collapses → 0; one merge event in the whole set). "Harder" on the scalar means
  turning the feature off, not tuning it.

### 4. A geometric second signal (margin) can't isolate the clones either. (measured)

`nearest − second_nearest ≥ margin` was ineffective across margins 0→0.10 (facts lost stayed 4). In the
sequential cascade each clone is absorbed *before* the next arrives, so the cluster is never present as
multiple survivors at once — the margin never trips. Geometry alone (scalar or margin) cannot separate an
enumeration from a correction.

> Illustrative, not production rates: the "3/13 merge, 4 lost" counts come from a dataset whose difficulty
> spread was deliberately balanced (per the label-vetting) to exercise the hard middle. Read them as direction
> and shape, not as expected field rates. Cosines are platform-dependent at the 3rd decimal.

## Recommendation

1. **Keep τ = 0.95 for e5 in production.** Do not bump the constant. The data shows no free-lunch scalar within
   the ≥ 0.95 floor: 0.96/0.97 are dominated, and 0.98+ disables auto-supersede. A one-dataset measurement is
   not grounds to move a shared, hot-path default.
2. **The correction miss stays owned by `memory_correct`** (deterministic, by-id) — confirmed the right backstop:
   even at 0.95 most real corrections don't auto-merge, and no safe scalar changes that.
3. **The real lever is non-geometric — a follow-up, not this PR.** Because the silent loss is concentrated in
   templated enumerations and both geometric signals provably fail to isolate them, the fix is a pattern-aware
   / opt-in dedup signal (e.g. detect `entity N`-style enumerations and refuse to collapse; or per-write
   `dedupe` opt-in the caller controls). Filed as the recommended next step.
4. **Product decision for Jeff, surfaced not silently resolved:** if you want an *immediate blunt lever* to kill
   the silent node-clone loss, τ = 0.98 does it — but it makes `memory_correct` the sole correction path and
   ends near-duplicate reinforcement (`source_count`). That's a product call, not a tuning win; the measured
   recommendation is to keep 0.95 and pursue the pattern-aware signal instead.

_Scope: e5 (quality) only. The static/potion tier's 0.98 default is unmeasured — a separate run with
`BELLA_EMBED_TIER=light` would characterize it. Write order = declaration order (the cascade is
order-dependent)._
