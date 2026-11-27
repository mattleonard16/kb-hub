/**
 * Cheap secret detection used before anything is written to a packet or the ledger.
 * CI also runs gitleaks; this catches the common cases at write time.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
];

/** Returns the names of secret kinds found in `text` (empty if none). */
export function findSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) found.add(name);
  }
  return [...found];
}

/** Replaces every detected secret with `[redacted:<kind>]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) out = out.replace(re, `[redacted:${name}]`);
  return out;
}
