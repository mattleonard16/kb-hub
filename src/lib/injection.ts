/**
 * Heuristics for instruction-like text aimed at agents (stored prompt injection).
 * A match does not block ingest; it marks the item so the curator rejects or reviews it,
 * and it is never compiled into always-on files.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "override",
    re: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|earlier)\b.{0,20}\b(instructions?|rules?|prompts?)\b/i,
  },
  { name: "role-hijack", re: /\b(you are now|act as|new system prompt|system prompt:)\b/i },
  {
    name: "exfiltrate",
    re: /\b(send|forward|email|post|upload|exfiltrate)\b.{0,60}\b(to|at)\b.{0,10}([\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/)/i,
  },
  { name: "hidden-directive", re: /<\s*(system|instructions?)\s*>|\[\[\s*system\s*\]\]/i },
  {
    name: "tool-coercion",
    re: /\b(always|must|never)\b.{0,40}\b(call|invoke|run|execute)\b.{0,30}\b(tool|command|function|curl|shell)\b/i,
  },
];

export function findInjection(text: string): string[] {
  return PATTERNS.filter(({ re }) => re.test(text)).map(({ name }) => name);
}
