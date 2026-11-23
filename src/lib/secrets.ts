/**
 * Cheap secret detection used by lint, ingest and the curator.
 * CI also runs gitleaks; this catches the common cases before anything is written.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Returns the names of secret kinds found in `text` (empty if none). */
export function findSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { name, re } of PATTERNS) if (re.test(text)) found.add(name);
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add("card-number");
  }
  return [...found];
}
