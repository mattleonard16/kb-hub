import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { parseFrontmatter } from "../lib/frontmatter.ts";

/**
 * `kb scan`: a map of a code repo for the curator, queued as a `repo` source. It records the
 * layout, the packages, the agent instructions and a catalog of the docs (with their OKF type,
 * title and description) at one commit. It never copies code: the repo stays the authority, and
 * wiki pages point back into it with `repo`, `resource` and `commit`.
 */

/** Never listed. Paths given with `--exclude` are added to these. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".expo",
  ".vercel",
  "coverage",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
]);
const MANIFESTS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]);
const AGENT_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MAX_FOLDERS = 600;
const MAX_DOCS = 3000;
const MAX_INSTRUCTIONS = 64 * 1024;

export type ScanPackage = {
  path: string;
  manifest: string;
  name?: string;
  description?: string;
  scripts: string[];
};
export type ScanDoc = { path: string; type?: string; title: string; description?: string };
export type RepoScan = {
  name: string;
  remote: string | null;
  commit: string | null;
  branch: string | null;
  files: number;
  excluded: string[];
  folders: Array<{ path: string; files: number }>;
  depth: number;
  packages: ScanPackage[];
  instructions: Array<{ path: string; sameAs?: string; text?: string }>;
  docs: ScanDoc[];
};

function git(dir: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** `github.com/owner/repo`, with any credentials in the URL dropped. */
export function cleanRemote(url: string): string {
  const u = url.trim().replace(/\.git$/, "");
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const p = new URL(u);
    return `${p.host}${p.pathname}`.replace(/\/$/, "");
  } catch {
    return u.replace(/^[a-z]+:\/\/[^@/]*@/, "");
  }
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(dir, p)));
    } else if (e.isFile() || e.isSymbolicLink()) out.push(p);
  }
  return out;
}

/** Tracked files when it is a git checkout (so .gitignore applies), otherwise a walk. */
async function listFiles(dir: string): Promise<string[]> {
  const tracked = git(dir, ["ls-files", "-z"]);
  const files = tracked === null ? await walk(dir) : tracked.split("\0").filter(Boolean);
  return files.filter((f) => !f.split("/").some((part) => SKIP_DIRS.has(part)));
}

function excludedBy(excluded: string[]): (f: string) => boolean {
  const prefixes = excluded.map((e) => e.replace(/^\.?\/+|\/+$/g, "")).filter(Boolean);
  return (f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`));
}

async function head(dir: string, path: string, bytes = 4096): Promise<string> {
  const f = Bun.file(join(dir, path));
  return (await f.slice(0, bytes).text()).replace(/\r\n/g, "\n");
}

function folderCounts(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return counts;
}

function isDoc(f: string): boolean {
  if (!/\.mdx?$/i.test(f)) return false;
  const parts = f.split("/");
  const base = parts.at(-1) ?? f;
  return (
    parts.length === 1 ||
    parts.includes("docs") ||
    base === "README.md" ||
    base === "CONCEPTS.md" ||
    AGENT_FILES.has(base) ||
    base === "SKILL.md"
  );
}

function docEntry(path: string, text: string): ScanDoc {
  const fm = parseFrontmatter(text);
  const meta = fm.ok ? (fm.data as Record<string, unknown>) : {};
  const body = fm.ok ? fm.body : text;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    path,
    type: str(meta.type) ?? str(meta.problem_type),
    title: str(meta.title) ?? str(meta.name) ?? heading ?? posix.basename(path),
    description: str(meta.description),
  };
}

export async function scanRepo(
  dir: string,
  opts: { name: string; exclude?: string[]; depth?: number },
): Promise<RepoScan> {
  const excluded = opts.exclude ?? [];
  const isExcluded = excludedBy(excluded);
  const files = (await listFiles(dir)).filter((f) => !isExcluded(f)).sort();

  // Folders, as deep as fits under the cap.
  const counts = folderCounts(files);
  let depth = opts.depth ?? 4;
  let folders = [...counts].filter(([d]) => d.split("/").length <= depth);
  while (folders.length > MAX_FOLDERS && depth > 1) {
    depth--;
    folders = folders.filter(([d]) => d.split("/").length <= depth);
  }

  const packages: ScanPackage[] = [];
  for (const f of files.filter((f) => MANIFESTS.has(posix.basename(f)))) {
    const path = posix.dirname(f) === "." ? "." : posix.dirname(f);
    const pkg: ScanPackage = { path, manifest: posix.basename(f), scripts: [] };
    if (pkg.manifest === "package.json") {
      try {
        const j = JSON.parse(await readFile(join(dir, f), "utf8")) as {
          name?: unknown;
          description?: unknown;
          scripts?: Record<string, unknown>;
        };
        if (typeof j.name === "string") pkg.name = j.name;
        if (typeof j.description === "string") pkg.description = j.description;
        pkg.scripts = Object.keys(j.scripts ?? {});
      } catch {
        // An unreadable manifest is still worth listing.
      }
    }
    packages.push(pkg);
  }
  packages.sort((a, b) => (a.path === "." ? -1 : b.path === "." ? 1 : a.path < b.path ? -1 : 1));

  // Agent instructions: the root ones in full, nested ones by path. Symlinked copies are named once.
  const instructions: RepoScan["instructions"] = [];
  const seen = new Map<string, string>();
  const agentFiles: Array<{ f: string; link: boolean }> = [];
  for (const f of files.filter((f) => AGENT_FILES.has(posix.basename(f)))) {
    const link = await lstat(join(dir, f)).then(
      (st) => st.isSymbolicLink(),
      () => false,
    );
    agentFiles.push({ f, link });
  }
  // The real file is named first, and links to it point at it.
  agentFiles.sort((a, b) => Number(a.link) - Number(b.link));
  for (const { f } of agentFiles) {
    let real = join(dir, f);
    try {
      real = await realpath(real);
      if (!(await lstat(real)).isFile()) continue;
    } catch {
      continue;
    }
    const first = seen.get(real);
    if (first) {
      instructions.push({ path: f, sameAs: first });
      continue;
    }
    seen.set(real, f);
    instructions.push(
      f.includes("/")
        ? { path: f }
        : { path: f, text: (await readFile(real, "utf8")).slice(0, MAX_INSTRUCTIONS) },
    );
  }

  const docs: ScanDoc[] = [];
  for (const f of files.filter(isDoc).slice(0, MAX_DOCS)) {
    try {
      docs.push(docEntry(f, await head(dir, f)));
    } catch {
      docs.push({ path: f, title: posix.basename(f) });
    }
  }

  const remote = git(dir, ["remote", "get-url", "origin"]);
  instructions.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    name: opts.name,
    remote: remote ? cleanRemote(remote) : null,
    commit: git(dir, ["rev-parse", "HEAD"])?.trim() ?? null,
    branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null,
    files: files.length,
    excluded,
    folders: folders
      .map(([path, n]) => ({ path, files: n }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    depth,
    packages,
    instructions,
    docs,
  };
}

const cell = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}markdown\n${text.replace(/\n*$/, "")}\n${f}`;
}

/** The queued source: Markdown with the scan's facts in frontmatter. Same commit, same file. */
export function renderScan(s: RepoScan): string {
  const fm = [
    "---",
    "kind: repo-scan",
    `repo: ${s.name}`,
    s.remote ? `remote: ${s.remote}` : "",
    s.commit ? `commit: ${s.commit}` : "",
    s.branch ? `branch: ${s.branch}` : "",
    `files: ${s.files}`,
    s.excluded.length ? `excluded: [${s.excluded.join(", ")}]` : "",
    "---",
  ].filter(Boolean);
  const out = [
    ...fm,
    `# Repo scan: ${s.name}`,
    "",
    `Generated by \`kb scan\`${s.commit ? ` at commit ${s.commit.slice(0, 12)}` : ""}. It maps the repo and does not copy its code: read the files themselves in the repo. File pages under \`repos/\`, \`modules/\`, \`features/\`, \`decisions/\` and \`lessons/\` with \`repo: ${s.name}\`, \`resource: <path>\`${s.commit ? ` and \`commit: ${s.commit}\`` : ""}.`,
    "",
    "## Packages",
    "",
  ];
  if (s.packages.length) {
    out.push(
      "| Path | Manifest | Name | Description | Scripts |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const p of s.packages)
      out.push(
        `| \`${p.path}\` | ${p.manifest} | ${cell(p.name)} | ${cell(p.description)} | ${cell(p.scripts.join(", "))} |`,
      );
  } else out.push("None found.");

  out.push("", `## Folders (file counts, ${s.depth} levels)`, "");
  for (const f of s.folders) {
    const level = f.path.split("/").length - 1;
    out.push(`${"  ".repeat(level)}- \`${f.path}/\` ${f.files}`);
  }

  out.push("", "## Agent instructions", "");
  if (!s.instructions.length) out.push("None found.");
  for (const i of s.instructions)
    out.push(`- \`${i.path}\`${i.sameAs ? ` (same file as \`${i.sameAs}\`)` : ""}`);
  for (const i of s.instructions.filter((i) => i.text))
    out.push("", `### ${i.path}`, "", fence(i.text ?? ""));

  out.push("", `## Docs (${s.docs.length})`);
  const groups = new Map<string, ScanDoc[]>();
  for (const d of s.docs) {
    const g = posix.dirname(d.path);
    groups.set(g, [...(groups.get(g) ?? []), d]);
  }
  for (const [g, list] of groups) {
    out.push("", `### ${g === "." ? "(root)" : g} (${list.length})`, "");
    out.push("| Path | Type | Title | Description |", "| --- | --- | --- | --- |");
    for (const d of list)
      out.push(`| \`${d.path}\` | ${cell(d.type)} | ${cell(d.title)} | ${cell(d.description)} |`);
  }
  return `${out.join("\n")}\n`;
}
