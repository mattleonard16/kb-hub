const STRUCK = /~~(.+?)~~/g;
/** What is left of a YAML list item or Markdown bullet once its struck text is gone. */
const EMPTY_ITEM = /^\s*(?:[-*]\s*)?(?:""|'')?\s*$/;

export type Struck = { text: string; field: string | null };

/**
 * Pulls `~~struck~~` text out of an edited packet. Struck segments are removed, and a list
 * item or line left empty by that is dropped. Returns the cleaned text and what was struck,
 * with the frontmatter field it came from (null for the body).
 */
export function extractStrikes(text: string): { text: string; struck: Struck[] } {
  const struck: Struck[] = [];
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = 0;
  let field: string | null = null;
  for (const line of lines) {
    if (line === "---" && fence < 2) {
      fence++;
      if (fence === 2) field = null;
      out.push(line);
      continue;
    }
    const inFrontmatter = fence === 1;
    if (inFrontmatter) {
      const key = /^([A-Za-z_][\w-]*):/.exec(line);
      if (key?.[1]) field = key[1];
    }
    if (!line.includes("~~")) {
      out.push(line);
      continue;
    }
    let found = false;
    const cleaned = line.replace(STRUCK, (_, inner: string) => {
      const t = inner.trim();
      if (t) struck.push({ text: t, field: inFrontmatter ? field : null });
      found = true;
      return "";
    });
    if (!found) {
      out.push(line);
      continue;
    }
    const isKeyLine = inFrontmatter && /^[A-Za-z_][\w-]*:\s*$/.test(cleaned) && /^\S/.test(line);
    if (isKeyLine) out.push(`${cleaned.trimEnd()} ""`);
    else if (!EMPTY_ITEM.test(cleaned)) {
      const indent = /^\s*/.exec(cleaned)?.[0] ?? "";
      out.push(
        indent +
          cleaned
            .slice(indent.length)
            .replace(/\s{2,}/g, " ")
            .trim(),
      );
    }
  }
  return { text: out.join("\n"), struck };
}
