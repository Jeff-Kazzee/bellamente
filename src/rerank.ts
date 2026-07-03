// rerank.ts - MMR diversity pass over an already-fused candidate list (P1.4, issue #37).
// Relevance-only ranking lets near-duplicate memories crowd the top-k; greedy Maximal Marginal
// Relevance re-picks the top-k trading relevance against similarity-to-already-picked. No model,
// no downloads, no extra embed calls: candidate embeddings ride along on the rows the search
// already fetched from the DB.

// Relevance vs redundancy trade-off. 0.5 is the industry-standard default (LangChain's
// lambda_mult, the midpoint of the original MMR paper's tested 0.3-0.7 range), and here it is
// also load-bearing: RRF gaps between adjacent ranks are tiny (~1/K²) while near-duplicate
// cosines approach 1.0, so a higher λ would let redundancy win every contest and make the pass
// a no-op in practice (pinned by P1.4 B1).
export const MMR_LAMBDA = 0.5;

// Candidate-pool depth for the pass, as a multiple of the requested limit. This bounds PROMOTION
// depth only — the non-diversified top-limit is always inside the pool, so no result that would
// have been returned can ever be lost to this cap; it just keeps the pass O(pool × limit) instead
// of scanning every fused candidate (up to 30× limit) per pick. 5× matches or exceeds the
// fetch_k:k ratio common in deployed MMR retrievers (e.g. LangChain's fetch_k=20 for k=4).
export const MMR_POOL_MULTIPLIER = 5;

export type MmrCandidate = { id: string; score: number; embedding: number[] | null };

// pgvector columns arrive as text ('[1,0,0,0]') through the pg-shim; be tolerant of drivers that
// hand back real arrays. Anything else (NULL: a never-embedded row) is "no embedding".
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string" && v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map(Number);
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const d = Math.sqrt(na * nb);
  return d > 0 ? dot / d : 0;
}

// Greedy MMR over a fused-order pool (best first): each pick maximizes
//   λ·relevance − (1−λ)·max cosine(candidate, already-picked).
// Relevance is the fused score min-max normalized WITHIN the pool — RRF scores are rank-shaped
// (~1/60), not cosine-shaped, and raw they would drown under the similarity penalty.
// Deterministic by construction: strict `>` keeps the earliest (fused-order) candidate on ties,
// so pick #1 is always the fused head and tie-break policy survives the rerank. A candidate with
// no embedding takes no similarity penalty (it cannot be shown redundant) rather than being dropped.
export function mmrRerank<T extends MmrCandidate>(pool: T[], limit: number, lambda = MMR_LAMBDA): T[] {
  if (limit <= 0) return [];
  if (pool.length <= 1 || limit <= 1) return pool.slice(0, limit);
  let lo = Infinity, hi = -Infinity;
  for (const c of pool) { lo = Math.min(lo, c.score); hi = Math.max(hi, c.score); }
  const range = hi - lo;
  const rel = (c: T) => (range > 0 ? (c.score - lo) / range : 1);
  const selected: T[] = [];
  const remaining = pool.slice();
  while (selected.length < limit && remaining.length > 0) {
    let bestI = 0, bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      let maxSim = -Infinity;
      if (c.embedding) {
        for (const s of selected) if (s.embedding) maxSim = Math.max(maxSim, cosine(c.embedding, s.embedding));
      }
      if (!Number.isFinite(maxSim)) maxSim = 0; // first pick, or nothing comparable: no penalty
      const val = lambda * rel(c) - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; bestI = i; }
    }
    selected.push(remaining.splice(bestI, 1)[0]!);
  }
  return selected;
}
