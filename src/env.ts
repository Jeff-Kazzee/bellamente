// env.ts - brand-aware configuration lookup. BELLA_* is the ONLY spelling (the pre-release legacy
// alias was removed before v0.0.1 — no released setup ever used it). Empty/whitespace values count
// as unset — an uncommented "BELLA_X=" template line must not shadow the default (same rule
// embed-common always used).
// Only node builtins on purpose: everything (paths, embed-common, the worker) can use it cycle-free.

function read(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v.trim() !== "" ? v : undefined;
}

export function brandEnv(suffix: string): string | undefined {
  return read("BELLA_" + suffix);
}
