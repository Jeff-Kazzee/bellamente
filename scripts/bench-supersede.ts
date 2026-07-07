// scripts/bench-supersede.ts — characterize (and safely tune) the supersede/collapse threshold.
//
// Supersede is pure: on write, the nearest existing latest memory in the same org+space is found by
// cosine, and if cosine >= τ the new write COLLAPSES onto it (new version, old flipped is_latest=false)
// — src/memories.ts:141-185. The default τ (DEFAULT_SUPERSEDE_THRESHOLD, memories.ts:31) is 0.95 for
// e5/wasm & openai, 0.98 for static — and has never been measured. The P3 MCP dogfood showed it fails
// BOTH ways: distinct-but-similar facts collapse (silent data loss) AND value-changing corrections miss.
//
// This harness measures WHERE the two populations actually land in cosine space and simulates the real
// SEQUENTIAL cascade (each write compares against the CURRENT survivor set; a collapse replaces that
// survivor's vector, exactly like writeMemory storing the new embedding as latest). Vectors are
// L2-normalized so a raw dot product == cosine (same as src/memories.ts:142 / src/search.ts:121).
//
// Pure + injectable embedder (no DB, no HTTP). Real e5 wired only under `import.meta.main`; the sibling
// test (test/bench-supersede.test.ts) drives the whole pipeline with a deterministic synthetic embedder.
// Write order == DATASET declaration order (the cascade is order-dependent — documented, not invariant).

import type { Embed } from "../src/embed";

export type Kind = "correction" | "distinct" | "unrelated";
export type Role = "original" | "update";
export type Write = { text: string; group: string; role: Role; kind: Kind };

// factId: writes that SHOULD end up as ONE memory share a factId.
//  - correction group  -> one fact (the update supersedes the original; all merge to 1 survivor).
//  - distinct/unrelated -> each write is its OWN fact (must never merge with another).
export function factId(w: Write, index: number): string {
  return w.kind === "correction" ? `corr:${w.group}` : `${w.kind}:${w.group}#${index}`;
}

// ---- dataset (validity gate: labels vetted independently; biased toward the overlap band) -----------
// correction groups: "original" then "update(s)" — the update is unambiguously the SAME fact changed.
// distinct groups: structurally near-identical, semantically distinct (the false-collapse hazard).
export const DATASET: Write[] = [
  // — corrections (should collapse to 1 survivor each) —
  { group: "wifi", role: "original", kind: "correction", text: "The office WiFi password is sunflower42." },
  { group: "wifi", role: "update", kind: "correction", text: "The office WiFi password is now bluejay1987." },
  { group: "manager", role: "original", kind: "correction", text: "John's manager is Priya." },
  { group: "manager", role: "update", kind: "correction", text: "John's manager is now Dale." },
  { group: "theme", role: "original", kind: "correction", text: "John prefers dark mode in his code editor." },
  { group: "theme", role: "update", kind: "correction", text: "John switched to light mode in his code editor." },
  { group: "location", role: "original", kind: "correction", text: "John lives in Denver, Colorado." },
  { group: "location", role: "update", kind: "correction", text: "John has moved to Boulder, Colorado." },
  { group: "deploy", role: "original", kind: "correction", text: "The staging deploy is currently failing." },
  { group: "deploy", role: "update", kind: "correction", text: "The staging deploy is now passing again." },
  { group: "car", role: "original", kind: "correction", text: "John drives a blue Tesla Model 3." },
  { group: "car", role: "update", kind: "correction", text: "John now drives a white Tesla Model 3." },
  { group: "standup", role: "original", kind: "correction", text: "The team standup is at 10am on Mondays." },
  { group: "standup", role: "update", kind: "correction", text: "The team standup has moved to 9:30am on Mondays." },
  { group: "dbver", role: "original", kind: "correction", text: "The production database is running Postgres 15." },
  { group: "dbver", role: "update", kind: "correction", text: "The production database has been upgraded to Postgres 16." },
  { group: "diet", role: "original", kind: "correction", text: "John is vegetarian and avoids meat." },
  { group: "diet", role: "update", kind: "correction", text: "John is no longer vegetarian and eats meat again." },
  { group: "phone", role: "original", kind: "correction", text: "John's work phone number is 555-0142." },
  { group: "phone", role: "update", kind: "correction", text: "John's new work phone number is 555-0199." },

  // — corrections that are full REPHRASES (same fact, few shared words -> LOW cosine; must still merge) —
  { group: "commute", role: "original", kind: "correction", text: "John bikes to work every day." },
  { group: "commute", role: "update", kind: "correction", text: "He gave up cycling and takes the train in now." },
  { group: "role", role: "original", kind: "correction", text: "Miguel works as the team's QA engineer." },
  { group: "role", role: "update", kind: "correction", text: "Miguel has moved into a product management position." },
  { group: "office", role: "original", kind: "correction", text: "The engineering team sits on the fourth floor." },
  { group: "office", role: "update", kind: "correction", text: "Everyone was relocated to the downtown annex." },

  // — distinct-but-similar: server nodes (the flagged false-collapse; each is a different machine) —
  { group: "node", role: "original", kind: "distinct", text: "Server node 1 is healthy and running version 2.3." },
  { group: "node", role: "original", kind: "distinct", text: "Server node 2 is healthy and running version 2.3." },
  { group: "node", role: "original", kind: "distinct", text: "Server node 3 is healthy and running version 2.3." },
  { group: "node", role: "original", kind: "distinct", text: "Server node 4 is healthy and running version 2.3." },
  { group: "node", role: "original", kind: "distinct", text: "Server node 5 is healthy and running version 2.3." },

  // — distinct-but-similar: config keys (different settings) —
  { group: "config", role: "original", kind: "distinct", text: "The MAX_RETRIES setting is configured to 3." },
  { group: "config", role: "original", kind: "distinct", text: "The MAX_TIMEOUT setting is configured to 30." },
  { group: "config", role: "original", kind: "distinct", text: "The MAX_CONNECTIONS setting is configured to 100." },
  { group: "config", role: "original", kind: "distinct", text: "The BATCH_SIZE setting is configured to 50." },

  // — distinct-but-similar: different people, same attribute type —
  { group: "allergy", role: "original", kind: "distinct", text: "Sarah is allergic to peanuts." },
  { group: "allergy", role: "original", kind: "distinct", text: "Tom is allergic to shellfish." },
  { group: "allergy", role: "original", kind: "distinct", text: "Rachel is allergic to penicillin." },

  // — distinct-but-similar: meetings —
  { group: "meeting", role: "original", kind: "distinct", text: "Meeting with Alice on Monday at 10am." },
  { group: "meeting", role: "original", kind: "distinct", text: "Meeting with Bob on Tuesday at 2pm." },
  { group: "meeting", role: "original", kind: "distinct", text: "Meeting with Carol on Wednesday at 4pm." },

  // — distinct-but-similar: flights —
  { group: "flight", role: "original", kind: "distinct", text: "Flight BA249 departs for Denver at 9am." },
  { group: "flight", role: "original", kind: "distinct", text: "Flight BA512 departs for Boston at 6pm." },
  { group: "flight", role: "original", kind: "distinct", text: "Flight BA733 departs for Seattle at 3pm." },

  // — distinct-but-similar: same value, only the SUBJECT differs (over-merge hazard) —
  { group: "salary", role: "original", kind: "distinct", text: "Diego's base salary is $120,000." },
  { group: "salary", role: "original", kind: "distinct", text: "Elena's base salary is $120,000." },
  { group: "salary", role: "original", kind: "distinct", text: "Farid's base salary is $120,000." },

  // — unrelated controls (must never collapse with anything) —
  { group: "misc", role: "original", kind: "unrelated", text: "The quarterly board meeting is scheduled for March." },
  { group: "misc", role: "original", kind: "unrelated", text: "Rust is John's favorite programming language." },
  { group: "misc", role: "original", kind: "unrelated", text: "The coffee machine on the third floor is broken." },
  { group: "misc", role: "original", kind: "unrelated", text: "Backups run nightly at 2am to the offsite bucket." },
];

// cosine == dot product for unit-normalized vectors (embedder L2-normalizes: src/embed-common.ts:148).
export const cos = (a: number[], b: number[]): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] as number) * (b[i] as number);
  return d;
};

// ---- sequential simulation: mirror writeMemory's nearest-latest cascade (memories.ts:141-185) --------
// A "slot" is a surviving latest memory. members = indices of writes merged into it; vec = the LAST
// merged write's embedding (writeMemory stores the NEW content's vector as the latest). Optional margin
// rule (nearest - second_nearest >= margin) is EXPLORATORY — never the default, never productionized here.
export type Slot = { members: number[]; vec: number[] };
export type SimResult = {
  slots: Slot[];
  correctCollapses: number; // event-level: write merged onto a same-fact survivor (good)
  falseCollapses: number; // event-level: write merged onto a different-fact survivor (silent loss)
  missedCorrections: number; // correction "update" that did NOT collapse AT ALL (the true group-merge
  //   failure — which also counts an update that false-collapsed elsewhere — is splitCorrectionFacts)
  lostFacts: number; // outcome-level: Σ over slots (distinct factIds in slot − 1). EXACT for distinct facts
  //   (1 write each) — the τ=0.95 headline; may over-count only correction facts via multi-hop merges at low τ.
  splitCorrectionFacts: number; // outcome-level: correction facts spread across >1 slot
  survivorsPerGroup: Record<string, number>; // # slots touching each group (node: ideal 5; corrections: 1)
};

export function simulate(writes: Write[], vecs: number[][], tau: number, margin = 0): SimResult {
  const slots: { members: number[]; vec: number[]; lastFact: string }[] = [];
  let correctCollapses = 0;
  let falseCollapses = 0;
  let missedCorrections = 0;

  writes.forEach((w, i) => {
    const fid = factId(w, i);
    // nearest + second-nearest current survivor by cosine (LIMIT 1 semantics + margin signal)
    let best = -Infinity, second = -Infinity, bestIdx = -1;
    for (let s = 0; s < slots.length; s++) {
      const sim = cos(vecs[i]!, slots[s]!.vec);
      if (sim > best) { second = best; best = sim; bestIdx = s; }
      else if (sim > second) { second = sim; }
    }
    const marginOk = margin <= 0 || bestIdx < 0 || best - second >= margin;
    const collapse = bestIdx >= 0 && best >= tau && marginOk;
    if (collapse) {
      const target = slots[bestIdx]!;
      if (target.lastFact === fid) correctCollapses++;
      else { falseCollapses++; }
      target.members.push(i);
      target.vec = vecs[i]!; // supersede: latest vector becomes the new write's (memories.ts:180)
      target.lastFact = fid;
    } else {
      if (w.kind === "correction" && w.role === "update") missedCorrections++;
      slots.push({ members: [i], vec: vecs[i]!, lastFact: fid });
    }
  });

  // outcome-level damage from the final slot assignment
  let lostFacts = 0;
  const correctionSlotCount: Record<string, number> = {};
  const survivorsPerGroup: Record<string, number> = {};
  for (const slot of slots) {
    const fids = new Set(slot.members.map((mi) => factId(writes[mi]!, mi)));
    lostFacts += fids.size - 1; // every extra distinct fact folded into this slot is a lost fact
    const groups = new Set(slot.members.map((mi) => writes[mi]!.group));
    for (const g of groups) survivorsPerGroup[g] = (survivorsPerGroup[g] ?? 0) + 1;
    for (const f of fids) if (f.startsWith("corr:")) correctionSlotCount[f] = (correctionSlotCount[f] ?? 0) + 1;
  }
  const splitCorrectionFacts = Object.values(correctionSlotCount).reduce((a, c) => a + Math.max(0, c - 1), 0);

  return {
    slots: slots.map((s) => ({ members: s.members, vec: s.vec })),
    correctCollapses, falseCollapses, missedCorrections, lostFacts, splitCorrectionFacts, survivorsPerGroup,
  };
}

// ---- separability: do the two populations overlap in cosine space? (the decisive artifact) -----------
export type Separability = {
  shouldMerge: number[]; // correction original<->update cosines (want HIGH so they merge)
  shouldNotMerge: number[]; // each write's nearest DIFFERENT-fact cosine (want LOW so it stays distinct)
  mergeMin: number; mergeMedian: number; mergeMax: number;
  confuseMin: number; confuseMedian: number; confuseMax: number;
  overlap: boolean; // min(shouldMerge) < max(shouldNotMerge) — no single scalar cleanly separates
  confusersAbove95: number; // distinct-fact pairs that sit >= 0.95 (would wrongly collapse at default)
  confuserPairs: { a: string; b: string; sim: number }[]; // WHICH pairs — to see if damage is concentrated
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function separability(writes: Write[], vecs: number[][]): Separability {
  // should-merge: consecutive writes within each correction group
  const byGroup = new Map<string, number[]>();
  writes.forEach((w, i) => {
    if (w.kind !== "correction") return;
    const arr = byGroup.get(w.group) ?? [];
    arr.push(i);
    byGroup.set(w.group, arr);
  });
  const shouldMerge: number[] = [];
  for (const idxs of byGroup.values())
    for (let k = 1; k < idxs.length; k++) shouldMerge.push(cos(vecs[idxs[k]!]!, vecs[idxs[k - 1]!]!));

  // should-not-merge distribution: for every write, its nearest write with a DIFFERENT factId
  const shouldNotMerge: number[] = [];
  writes.forEach((w, i) => {
    const fid = factId(w, i);
    let best = -Infinity;
    writes.forEach((w2, j) => {
      if (j === i || factId(w2, j) === fid) return;
      const sim = cos(vecs[i]!, vecs[j]!);
      if (sim > best) best = sim;
    });
    if (best > -Infinity) shouldNotMerge.push(best);
  });

  // confusers: EXACT distinct-fact unordered pairs sitting >= 0.95 (would wrongly collapse) — keep WHICH.
  const confuserPairs: { a: string; b: string; sim: number }[] = [];
  for (let i = 0; i < writes.length; i++)
    for (let j = i + 1; j < writes.length; j++) {
      if (factId(writes[i]!, i) === factId(writes[j]!, j)) continue;
      const sim = cos(vecs[i]!, vecs[j]!);
      if (sim >= 0.95) confuserPairs.push({ a: writes[i]!.text, b: writes[j]!.text, sim });
    }
  confuserPairs.sort((p, q) => q.sim - p.sim);

  return {
    shouldMerge, shouldNotMerge,
    mergeMin: Math.min(...shouldMerge), mergeMedian: median(shouldMerge), mergeMax: Math.max(...shouldMerge),
    confuseMin: Math.min(...shouldNotMerge), confuseMedian: median(shouldNotMerge), confuseMax: Math.max(...shouldNotMerge),
    overlap: Math.min(...shouldMerge) < Math.max(...shouldNotMerge),
    confusersAbove95: confuserPairs.length, confuserPairs,
  };
}

// ---- threshold sweep --------------------------------------------------------------------------------
export type SweepRow = {
  tau: number;
  correctCollapses: number; falseCollapses: number; missedCorrections: number;
  lostFacts: number; splitCorrectionFacts: number; survivors: number; idealSurvivors: number;
};

export function sweep(writes: Write[], vecs: number[][], taus: number[]): SweepRow[] {
  const idealSurvivors = new Set(writes.map((w, i) => factId(w, i))).size;
  return taus.map((tau) => {
    const r = simulate(writes, vecs, tau);
    return {
      tau,
      correctCollapses: r.correctCollapses, falseCollapses: r.falseCollapses, missedCorrections: r.missedCorrections,
      lostFacts: r.lostFacts, splitCorrectionFacts: r.splitCorrectionFacts,
      survivors: r.slots.length, idealSurvivors,
    };
  });
}

// ---- margin sweep: does a second signal (nearest − second_nearest >= m) help? (exploratory) --------
export type MarginRow = { margin: number; correctCollapses: number; falseCollapses: number; lostFacts: number };
export function marginSweep(writes: Write[], vecs: number[][], tau: number, margins: number[]): MarginRow[] {
  return margins.map((margin) => {
    const r = simulate(writes, vecs, tau, margin);
    return { margin, correctCollapses: r.correctCollapses, falseCollapses: r.falseCollapses, lostFacts: r.lostFacts };
  });
}

// ---- report (Markdown to stdout) --------------------------------------------------------------------
export function formatReport(
  writes: Write[], sep: Separability, rows: SweepRow[], nodesAt: { tau: number; sim: SimResult }, marginRows: MarginRow[],
): string {
  const f = (n: number) => n.toFixed(4);
  const lines: string[] = [];
  lines.push("## Supersede-threshold benchmark\n");
  lines.push(`Dataset: ${writes.length} writes · ${new Set(writes.map((w, i) => factId(w, i))).size} distinct facts · write order = declaration order (cascade is order-dependent).\n`);

  lines.push("### 1. Separability — do the two populations overlap?\n");
  lines.push("| population | n | min | median | max |");
  lines.push("|---|---:|---:|---:|---:|");
  lines.push(`| should-MERGE (correction update↔prior) | ${sep.shouldMerge.length} | ${f(sep.mergeMin)} | ${f(sep.mergeMedian)} | ${f(sep.mergeMax)} |`);
  lines.push(`| should-NOT-merge (nearest different fact) | ${sep.shouldNotMerge.length} | ${f(sep.confuseMin)} | ${f(sep.confuseMedian)} | ${f(sep.confuseMax)} |`);
  lines.push("");
  lines.push(`- **Overlap: ${sep.overlap ? "YES" : "NO"}** (min should-merge ${f(sep.mergeMin)} ${sep.overlap ? "<" : ">="} max should-not-merge ${f(sep.confuseMax)}).`);
  lines.push(`- Distinct-fact PAIRS sitting ≥ 0.95: **${sep.confusersAbove95}** — pairwise, NOT a collapse-event count.`);
  lines.push("  (the sequential cascade turns a cluster of K clones into only K−1 actual over-merge events — see §3.)");
  lines.push(sep.overlap
    ? "- ⇒ **No single scalar cleanly separates the two.** A scalar can only trade one error for the other."
    : "- ⇒ The two separate; a scalar at the midpoint would work.");
  if (sep.confuserPairs.length) {
    lines.push("");
    lines.push("Which distinct-fact pairs sit ≥ 0.95 (is the hazard broad, or concentrated in near-clones?):");
    lines.push("");
    lines.push("| cosine | fact A | fact B |");
    lines.push("|---:|---|---|");
    for (const p of sep.confuserPairs) lines.push(`| ${f(p.sim)} | ${p.a} | ${p.b} |`);
  }
  lines.push("");

  lines.push("### 2. Threshold sweep (sequential cascade)\n");
  lines.push("| τ | correct collapses | FALSE collapses | missed corrections | facts lost (over-merge) | split corrections | survivors / ideal |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows)
    lines.push(`| ${r.tau.toFixed(2)} | ${r.correctCollapses} | ${r.falseCollapses} | ${r.missedCorrections} | ${r.lostFacts} | ${r.splitCorrectionFacts} | ${r.survivors} / ${r.idealSurvivors} |`);
  lines.push("");
  lines.push("- **facts lost (over-merge)** = distinct facts silently swallowed by a wrong merge — the dangerous, invisible error.");
  lines.push("- **missed corrections / split corrections** = a value-changing update that did NOT collapse (backstopped by `memory_correct`).");
  lines.push("");

  lines.push(`### 3. Where does the over-merge land? (per distinct group, τ=${nodesAt.tau.toFixed(2)})\n`);
  // ideal facts per distinct group (each distinct write is its own fact)
  const idealPerGroup: Record<string, number> = {};
  for (const w of writes) if (w.kind === "distinct") idealPerGroup[w.group] = (idealPerGroup[w.group] ?? 0) + 1;
  lines.push("| distinct group | ideal facts | survived | lost |");
  lines.push("|---|---:|---:|---:|");
  for (const [g, ideal] of Object.entries(idealPerGroup)) {
    const survived = nodesAt.sim.survivorsPerGroup[g] ?? 0;
    lines.push(`| ${g} | ${ideal} | ${survived} | ${ideal - survived} |`);
  }
  lines.push("");
  lines.push(`- Total: ${nodesAt.sim.slots.length} survivors from ${writes.length} writes; **${nodesAt.sim.lostFacts} facts lost to over-merge**, ${nodesAt.sim.splitCorrectionFacts} corrections left un-merged.`);
  lines.push("- If the loss is concentrated in ONE enumerated group (server node 1..N), the silent-loss risk is templated near-clones — not same-topic distinct facts, which e5 keeps apart by subject/key.");
  lines.push("");

  lines.push(`### 4. Margin rule at τ=${nodesAt.tau.toFixed(2)} (exploratory — a second signal, NOT productionized here)\n`);
  lines.push("Collapse only if `nearest − second_nearest >= margin` (a genuine correction has one clear match; a");
  lines.push("cluster of near-duplicates does not). Note: in the sequential cascade each clone is absorbed BEFORE");
  lines.push("the next arrives, so the cluster is rarely present as multiple survivors at once — expect weak effect.\n");
  lines.push("| margin | correct collapses | FALSE collapses | facts lost (over-merge) |");
  lines.push("|---:|---:|---:|---:|");
  for (const m of marginRows)
    lines.push(`| ${m.margin.toFixed(2)} | ${m.correctCollapses} | ${m.falseCollapses} | ${m.lostFacts} |`);
  lines.push("");
  return lines.join("\n");
}

// ---- orchestration: embed → separability → sweep → cascade → report (testable; injected embedder) ---
export const DEFAULT_TAUS = [0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99];

export async function run(
  embed: Embed,
  writes: Write[] = DATASET,
  taus: number[] = DEFAULT_TAUS,
): Promise<{ report: string; sep: Separability; rows: SweepRow[]; at95: SimResult; marginRows: MarginRow[]; dim: number }> {
  const vecs = await embed({ values: writes.map((w) => w.text), taskType: "RETRIEVAL_DOCUMENT" });
  const sep = separability(writes, vecs);
  const rows = sweep(writes, vecs, taus);
  const at95 = simulate(writes, vecs, 0.95);
  const marginRows = marginSweep(writes, vecs, 0.95, [0, 0.02, 0.05, 0.1]);
  const report = formatReport(writes, sep, rows, { tau: 0.95, sim: at95 }, marginRows);
  return { report, sep, rows, at95, marginRows, dim: vecs[0]?.length ?? 0 };
}

// ---- real-embed entrypoint (only wired here; the test injects a synthetic embedder) -----------------
if (import.meta.main) {
  process.env.BELLA_EMBED_TIER = process.env.BELLA_EMBED_TIER ?? "quality";
  const { makeEmbed } = await import("../src/embed");
  const t0 = Date.now();
  const { report, dim } = await run(makeEmbed());
  console.log(report);
  console.log(`\n> Scope: e5 (quality tier), ${DATASET.length} writes in ${Date.now() - t0}ms, dim=${dim}. This characterizes`);
  console.log("> the **e5 0.95 default only**; the static/potion tier's 0.98 default is unmeasured. Cosines are");
  console.log("> platform-dependent at the 3rd decimal — don't over-index on borderline flips.");
  process.exit(0);
}
