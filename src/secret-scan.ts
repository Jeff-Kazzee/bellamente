// secret-scan.ts - detect + redact high-confidence credential FORMATS before free text is stored as a memory.
//
// SCOPE (deliberately narrow): only formats a legitimate memory has no reason to contain verbatim — private
// keys and live cloud/service credentials. This is NOT a general secret scanner and does not claim to be: a
// plain password ("hunter2"), a novel/custom token format, or a secret described in prose is indistinguishable
// from normal text and is OUT OF SCOPE by design. The goal is to stop the common accident (an agent or user
// pasting a real API key into a memory) WITHOUT eating legitimate developer memories — for this product, whose
// users are coding agents and developers, a false positive (blocking a real memory) is the worse failure, so
// every pattern is tightly anchored and documented placeholders (…EXAMPLE keys) are deliberately left alone.
//
// Used at the single memory-write choke point (writeMemories) + the correction path (PATCH /:id), so manual
// POST /memories, MCP memory_write, the batch body, and proxy auto-capture are all covered by one gate.

export type SecretKind =
  | "private key"
  | "AWS access key"
  | "GitHub token"
  | "GitLab token"
  | "Slack token"
  | "Stripe secret key"
  | "OpenAI API key"
  | "Anthropic API key"
  | "Google API key"
  | "HuggingFace token"
  | "npm token"
  | "credential"; // provider-agnostic: a value explicitly labeled as a key/token/secret/password

// Each entry is anchored + specific enough that a match is almost certainly a real credential, not a doc
// example. Order matters only for the private-key block (full block before the bare header). All global so
// `replace` swaps every occurrence.
const PATTERNS: { kind: SecretKind; re: RegExp }[] = [
  // Full PEM block (any key type), then the bare BEGIN header (a truncated paste still shouldn't land raw).
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  // AWS access key id (AKIA/ASIA + 16 upper/digits). Example keys end in EXAMPLE — excluded below.
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub: classic ghX_ + 36, and fine-grained github_pat_.
  { kind: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { kind: "GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // Slack bot/user/app/refresh/legacy tokens.
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe LIVE secret/restricted keys only (test keys sk_test_/rk_test_ are safe to store and are left alone).
  { kind: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  // Anthropic + OpenAI project keys are unambiguous by prefix; legacy OpenAI is sk- + exactly 48 base62.
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9]{2,}-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI API key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI API key", re: /\bsk-[A-Za-z0-9]{48}\b/g },
  // Google API key.
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // A few more unambiguous prefixes (the contextual layer below covers the long tail of providers).
  { kind: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20}\b/g },
  { kind: "HuggingFace token", re: /\bhf_[A-Za-z0-9]{34}\b/g },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

// PROVIDER-AGNOSTIC contextual detection: a value explicitly labeled as a secret. This is what actually covers
// "every provider" — it keys on the LABEL (you called it a key/token/secret/password), not the value's format,
// so a credential from a provider we've never heard of is still caught. The captured value must be token-shaped
// (see tokenShaped) so we redact credentials, not English ("the password is required", "the api key is in 1Password").
// The value charset excludes '.' , ',' etc. on purpose: consuming trailing sentence punctuation ("the password
// is alpha-1.") both mis-measures the length and mangles prose. Secret chars we keep: alphanumerics, _ - / + =.
const LABELED_SECRET =
  /\b((?:(?:api|access|secret|client|auth|private|refresh)[\s_-]*)?(?:keys?|tokens?|secrets?|passwords?|passwd|passphrases?|credentials?|bearer))(\s*(?::|=|:=|->|\bis\b)\s*)(["'`]?)([A-Za-z0-9_/+=-]{8,})\3/gi;

// A value worth redacting looks like a token, not a word: long enough, and with a digit or mixed case (English
// prose is lowercase words without digits). Length 8 keeps short English out while catching real short-ish keys.
function tokenShaped(v: string): boolean {
  if (v.length < 8) return false;
  return /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}

// Documented-placeholder guard: providers deliberately make example credentials contain "EXAMPLE"
// (canonically AWS's AKIAIOSFODNN7EXAMPLE). Never redact a match that carries it — favouring a rare
// false-negative over blocking the tutorial content our users legitimately store.
const PLACEHOLDER = /EXAMPLE/i;

/** Replace known credential formats AND labeled secrets with `[redacted: <kind>]`; report the kinds found. */
export function redactSecrets(text: string): { redacted: string; found: SecretKind[] } {
  const found = new Set<SecretKind>();
  let redacted = text;
  // 1. Known formats first (zero false positives).
  for (const { kind, re } of PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      if (PLACEHOLDER.test(match)) return match; // documented example — leave it
      found.add(kind);
      return `[redacted: ${kind}]`;
    });
  }
  // 2. Provider-agnostic labeled values (catches keys we don't have a format for). Keeps the label + separator,
  //    redacts only the value, and only when it is token-shaped (not English) and not a documented placeholder.
  redacted = redacted.replace(LABELED_SECRET, (m, label: string, sep: string, quote: string, value: string) => {
    if (PLACEHOLDER.test(value) || !tokenShaped(value)) return m;
    found.add("credential");
    return `${label}${sep}${quote}[redacted: credential]${quote}`;
  });
  return { redacted, found: [...found] };
}

/** The kinds of credential present in `text` (empty if none). Non-mutating. */
export function scanSecrets(text: string): SecretKind[] {
  return redactSecrets(text).found;
}

/** Redact credentials in EVERY string value of an arbitrary JSON value (e.g. memory `metadata`, which is a
 *  structured side-channel a raw key could ride in through). Numbers/bools/null pass unchanged; cycle-guarded. */
export function redactSecretsDeep(value: unknown): { value: unknown; found: SecretKind[] } {
  const found = new Set<SecretKind>();
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      for (const k of r.found) found.add(k);
      return r.redacted;
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return v; // parsed JSON has no cycles, but never loop
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  return { value: walk(value), found: [...found] };
}
