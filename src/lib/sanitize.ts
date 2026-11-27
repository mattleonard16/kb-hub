import { redactSecrets } from "./secrets.ts";

export const DEFAULT_LIMIT_BYTES = 4096;

/** A line that looks like an environment assignment: `KEY=value`, `export KEY=value`. */
const ENV_LINE = /^\s*(?:export\s+|set\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/;

/**
 * Prepares untrusted text (test output, review evidence) for a packet or the ledger:
 * drops env-like `KEY=VALUE` lines, redacts secrets, then truncates to `limit` bytes.
 */
export function sanitize(text: string, limit = DEFAULT_LIMIT_BYTES): string {
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !ENV_LINE.test(line))
    .join("\n");
  return truncateBytes(redactSecrets(kept), limit);
}

/** Truncates to at most `limit` UTF-8 bytes, keeping whole characters and marking the cut. */
export function truncateBytes(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  const marker = "\n[truncated]";
  const room = Math.max(0, limit - marker.length);
  const cut = new TextDecoder().decode(bytes.slice(0, room)).replace(/�+$/, "");
  return cut + marker;
}

/** Keeps the last `limit` bytes, for command output where the end matters most. */
export function tailBytes(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  const marker = "[truncated]\n";
  const room = Math.max(0, limit - marker.length);
  const cut = new TextDecoder().decode(bytes.slice(bytes.length - room)).replace(/^�+/, "");
  return marker + cut;
}
