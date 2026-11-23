/**
 * Links between wiki pages. Pages link with Obsidian wikilinks, `[[projects/kb-hub]]` or
 * `[[kb-hub|the hub]]`, so the repo works as an Obsidian vault with a graph view. Plain Markdown
 * links to `.md` pages (`[x](/wiki/projects/kb-hub.md)`) count too.
 */
const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const MDLINK = /\]\((\/?(?:(?:wiki|knowledge)\/)?[\w./-]+?)\.md(?:#[^)]*)?\)/g;

/** Normalize a link target to a page id: no leading slash, no wiki/ prefix, no .md. */
export function toId(target: string): string {
  return target
    .trim()
    .replace(/^\/+/, "")
    .replace(/^(wiki|knowledge)\//, "")
    .replace(/\.md$/, "");
}

/** Every link target written in a page body, normalized, in order, without duplicates. */
export function linkTargets(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK)) if (m[1]) out.add(toId(m[1]));
  for (const m of body.matchAll(MDLINK)) if (m[1]) out.add(toId(m[1]));
  return [...out];
}

/**
 * Resolve a target the way Obsidian does: an exact id, or else a page whose file name matches
 * when only one does. Returns null for a broken or ambiguous link.
 */
export function resolveLink(
  target: string,
  ids: Set<string>,
  byName: Map<string, string[]>,
): string | null {
  if (ids.has(target)) return target;
  if (target.includes("/")) return null;
  const matches = byName.get(target) ?? [];
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export type LinkGraph = {
  /** Outgoing links that resolved, by page id. */
  links: Map<string, string[]>;
  /** Pages that link to each page. */
  backlinks: Map<string, string[]>;
  /** Links that point nowhere, by page id. */
  broken: Map<string, string[]>;
};

export function linkGraph(pages: Array<{ id: string; body: string }>): LinkGraph {
  const ids = new Set(pages.map((p) => p.id));
  const byName = new Map<string, string[]>();
  for (const id of ids) {
    const name = id.split("/").at(-1) ?? id;
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  const links = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const broken = new Map<string, string[]>();
  for (const p of pages) {
    const out: string[] = [];
    for (const t of linkTargets(p.body)) {
      const r = resolveLink(t, ids, byName);
      if (!r) broken.set(p.id, [...(broken.get(p.id) ?? []), t]);
      else if (r !== p.id && !out.includes(r)) out.push(r);
    }
    links.set(p.id, out);
    for (const r of out) backlinks.set(r, [...(backlinks.get(r) ?? []), p.id]);
  }
  return { links, backlinks, broken };
}
