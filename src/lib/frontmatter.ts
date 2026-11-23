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
    return { ok: false, error: `invalid YAML: ${(err as Error).message}` };
  }
}
