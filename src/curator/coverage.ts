import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * `kb coverage <repo>`: which docs in the repo's latest scan no wiki page covers yet. A big repo
 * (94 ADRs, 25 lessons, an OKF bundle) takes several curator runs; this is how a run knows what
 * the earlier ones already filed, without a list anyone has to keep up to date.
 */

/** Docs that never become pages: indexes, logs, audits and working notes change too fast. */
const SKIP_TYPES = new Set(["index", "log", "audit"]);
const SKIP_FOLDERS = /(^|\/)(plans|brainstorms|handoffs|todos|ideation)(\/|$)/;
const SKIP_FILES = new Set(["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]);

export type CoverageDoc = { path: string; type: string; title: string; code?: string };
export type Coverage = {
  repo: string;
  scan: string;
  commit: string | null;
  total: number;
  covered: number;
  skipped: number;
  uncovered: CoverageDoc[];
};

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** The newest `kb scan` of `repo` in raw/ (file names start with the date). */
export async function latestScan(
  root: string,
  repo: string,
): Promise<{ path: string; text: string } | null> {
  const files = (await walk(join(root, "raw"))).sort().reverse();
  for (const f of files) {
    // Only scans queued by the CLI (`<date>-cli-repo-...`) count; agents cannot queue one.
    if (!/^\d{4}-\d{2}-\d{2}-cli-repo-/.test(posix.basename(f.split("\\").join("/")))) continue;
    const text = await readFile(f, "utf8");
    if (text.startsWith("---\nkind: repo-scan\n") && text.includes(`\nrepo: ${repo}\n`))
      return {
        path: posix.normalize(
          f
            .slice(root.length + 1)
            .split("\\")
            .join("/"),
        ),
        text,
      };
  }
  return null;
}

/** Rows of the scan's docs tables: path, type and title, read by column name. */
export function scanDocs(text: string): CoverageDoc[] {
  const cells = (line: string) =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
  const out: CoverageDoc[] = [];
  let cols: string[] = [];
  for (const line of text.slice(text.indexOf("\n## Docs")).split("\n")) {
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const row = cells(line);
    if (row[0] === "Path") cols = row.map((c) => c.toLowerCase());
    else if (row[0]?.startsWith("`")) {
      const get = (name: string) => row[cols.indexOf(name)] ?? "";
      const code = get("code").replace(/^`|`$/g, "");
      out.push({
        path: get("path").replace(/^`|`$/g, ""),
        type: get("type"),
        title: get("title"),
        ...(code ? { code } : {}),
      });
    }
  }
  return out;
}

export async function coverage(
  root: string,
  repo: string,
  pages: Array<{
    body: string;
    meta: { type: string; repo?: string; resource?: string; ignore?: string[] };
  }>,
): Promise<Coverage> {
  const scan = await latestScan(root, repo);
  if (!scan) throw new Error(`no kb scan of "${repo}" in raw/. Run kb scan, then the curator.`);
  const mine = pages.filter((p) => p.meta.repo === repo);
  const resources = new Set(mine.map((p) => p.meta.resource).filter(Boolean));
  const text = mine.map((p) => p.body).join("\n");
  const all = scanDocs(scan.text);
  // The repo page's `ignore` list: docs the owner never wants here, such as customer or prospect notes.
  const ignore = mine.find((p) => p.meta.type === "repo")?.meta.ignore ?? [];
  const ignored = (path: string) => ignore.some((g) => globToRegExp(g).test(path));
  const wanted = all.filter(
    (d) =>
      !ignored(d.path) &&
      !SKIP_TYPES.has(d.type) &&
      !SKIP_FOLDERS.test(d.path) &&
      !SKIP_FILES.has(posix.basename(d.path)),
  );
  const isCovered = (d: CoverageDoc) => {
    if (resources.has(d.path) || text.includes(d.path)) return true;
    // A page about the code a doc describes covers that doc.
    if (d.code && resources.has(d.code)) return true;
    // A page about a generated bundle or a folder covers every doc in it.
    for (const r of resources) if (r && r !== "." && d.path.startsWith(`${r}/`)) return true;
    // ADRs are usually cited by number on the module or feature page they govern.
    const adr = /(?:^|\/)(?:adr|decisions)\/(\d{3,4})-[^/]+\.md$/.exec(d.path)?.[1];
    return !!adr && new RegExp(`\\b${adr}\\b`).test(text);
  };
  const uncovered = wanted.filter((d) => !isCovered(d));
  return {
    repo,
    scan: scan.path,
    commit: /\ncommit: ([0-9a-f]+)\n/.exec(scan.text)?.[1] ?? null,
    total: wanted.length,
    covered: wanted.length - uncovered.length,
    skipped: all.length - wanted.length,
    uncovered,
  };
}

/** `docs/*-demo-*` style patterns: `*` stays inside one folder, `**` spans folders, and a bare
 * folder matches everything under it. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.?\/+|\/+$/g, "");
  const body = g
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}(/.*)?$`);
}
