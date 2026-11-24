export type ParsedDoc = { ok: true; data: unknown; body: string } | { ok: false; error: string };

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a Markdown file into YAML frontmatter and body, using Bun's built-in YAML parser. */
export function parseFrontmatter(text: string): ParsedDoc {
  const match = FENCE.exec(text);
  if (!match) return { ok: false, error: "missing YAML frontmatter (file must start with ---)" };
  const [, yaml = "", body = ""] = match;
  try {
    const data = Bun.YAML.parse(yaml);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "frontmatter must be a YAML mapping" };
    }
    return { ok: true, data, body };
  } catch (err) {
    const hint = quoteHint(yaml);
    return {
      ok: false,
      error: `invalid YAML: ${(err as Error).message}${hint ? `. ${hint}` : ""}`,
    };
  }
}

/**
 * The usual cause of a YAML error in a page: an unquoted value that contains ": " or starts with
 * a character YAML reserves, such as `description: @scope/pkg: the web app`.
 */
export function quoteHint(yaml: string): string | null {
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*): (.+)$/.exec(line);
    const [, key, value = ""] = m ?? [];
    if (!key || /^["'[{|>]/.test(value)) continue;
    if (/: |\s#/.test(value) || /^[@`%&*!]/.test(value))
      return `Put the value of "${key}" in double quotes: it contains ": " or " #", or starts with a reserved character`;
  }
  return null;
}
