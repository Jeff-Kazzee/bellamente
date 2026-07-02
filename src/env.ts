// env.ts - brand-aware configuration lookup. BELLA_* is the documented name (BRAND.md rebrand);
// EUNOIA_* is honored PERMANENTLY as a legacy alias so no existing setup ever breaks. BELLA_ wins
// when both are set. Empty/whitespace values count as unset — an uncommented "BELLA_X=" template
// line must not shadow the legacy value or the default (same rule embed-common always used).
// Zero imports on purpose: everything (paths, embed-common, the worker) can use it cycle-free.
let warnedLegacy = false;

function read(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v.trim() !== "" ? v : undefined;
}

export function brandEnv(suffix: string): string | undefined {
  const bella = read("BELLA_" + suffix);
  if (bella !== undefined) return bella;
  const legacy = read("EUNOIA_" + suffix);
  if (legacy !== undefined && !warnedLegacy) {
    warnedLegacy = true;
    console.warn(
      `[config] EUNOIA_${suffix} still works but is a legacy alias — the documented names are BELLA_* (README).`,
    );
  }
  return legacy;
}
