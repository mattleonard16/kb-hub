import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { renderIndex } from "../compile/wiki-index.ts";
import { loadKnowledge } from "../index/load.ts";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import { linkGraph } from "../lib/links.ts";
import { findSecrets } from "../lib/secrets.ts";
import { ConceptFrontmatter, SkillFrontmatter } from "../schema/concept.ts";

export type Issue = {
  file: string;
  level: "error" | "warning";
  rule: string;
  message: string;
};

export type LintResult = {
  root: string;
  filesChecked: number;
  concepts: number;
  skills: number;
  issues: Issue[];
  ok: boolean;
};

/** Size caps for compiled always-on outputs (see build plan, "Always-on rule"). */
export const SIZE_CAPS: Record<string, { lines?: number; chars?: number }> = {
  "build/claude.md": { lines: 150 },
  "build/agents.md": { lines: 150 },
  "build/paste/chatgpt.md": { chars: 1500 },
};

const RESERVED = new Set(["index.md", "log.md"]);
/** Karpathy's log format: `## [2026-11-23] ingest | Claude extraction`. */
const LOG_HEADING = /^## \[\d{4}-\d{2}-\d{2}\] (ingest|query|lint|promote) \| \S.*$/;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

function zodIssues(
  file: string,
  rule: string,
  error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> },
): Issue[] {
  return error.issues.map((i) => ({
    file,
    level: "error" as const,
    rule,
    message: `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`,
  }));
}

/**
 * Validate a knowledge repo: concept frontmatter, skills, OKF reserved files,
 * secrets anywhere, and size caps on compiled outputs.
 */
export async function lintKnowledge(root: string): Promise<LintResult> {
  const issues: Issue[] = [];
  let concepts = 0;
  let skills = 0;
  const titles = new Map<string, string>();
  const rel = (p: string) => relative(root, p).split(sep).join("/");

  if (!(await exists(join(root, "wiki")))) {
    issues.push({
      file: ".",
      level: "error",
      rule: "layout",
      message: `no wiki/ folder under ${root}. Is KB_KNOWLEDGE_DIR pointing at the knowledge repo?`,
    });
  }

  const all = await walk(root);
  const textFiles = all.filter(
    (f) => /\.(md|ya?ml|txt|json)$/i.test(f) && !rel(f).startsWith("node_modules/"),
  );

  for (const file of textFiles) {
    const r = rel(file);
    const text = await readFile(file, "utf8");

    const secrets = findSecrets(text);
    if (secrets.length) {
      issues.push({
        file: r,
        level: "error",
        rule: "no-secrets",
        message: `possible secret (${secrets.join(", ")}). Remove it; secrets never belong in the knowledge base.`,
      });
    }

    const name = r.split("/").at(-1) ?? r;

    if (r.startsWith("wiki/") && r.endsWith(".md")) {
      if (RESERVED.has(name)) {
        if (name === "log.md") {
          for (const line of text.split("\n")) {
            if (line.startsWith("## ") && !LOG_HEADING.test(line)) {
              issues.push({
                file: r,
                level: "error",
                rule: "log-format",
                message: `log.md entries must look like "## [YYYY-MM-DD] ingest | Title" (ops: ingest, query, lint, promote), got "${line}"`,
              });
            }
          }
        }
        continue;
      }
      concepts++;
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) {
        issues.push({ file: r, level: "error", rule: "frontmatter", message: parsed.error });
        continue;
      }
      const result = ConceptFrontmatter.safeParse(parsed.data);
      if (!result.success) {
        issues.push(...zodIssues(r, "concept-schema", result.error));
        continue;
      }
      if (!parsed.body.trim()) {
        issues.push({
          file: r,
          level: "warning",
          rule: "empty-body",
          message: "concept has no body text",
        });
      }
      const key = result.data.title.toLowerCase();
      const prior = titles.get(key);
      if (prior) {
        issues.push({
          file: r,
          level: "warning",
          rule: "duplicate-title",
          message: `same title as ${prior}; the curator should merge them`,
        });
      } else titles.set(key, r);
      continue;
    }

    if (r.startsWith("skills/") && name === "SKILL.md") {
      skills++;
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) {
        issues.push({ file: r, level: "error", rule: "frontmatter", message: parsed.error });
        continue;
      }
      const result = SkillFrontmatter.safeParse(parsed.data);
      if (!result.success) {
        issues.push(...zodIssues(r, "skill-schema", result.error));
        continue;
      }
      const folder = r.split("/").at(-2);
      if (folder !== result.data.name) {
        issues.push({
          file: r,
          level: "error",
          rule: "skill-name",
          message: `name "${result.data.name}" must match its folder "${folder}"`,
        });
      }
    }
  }

  issues.push(...(await wikiIssues(root)));

  for (const [path, cap] of Object.entries(SIZE_CAPS)) {
    const full = join(root, path);
    if (!(await exists(full))) continue;
    const text = await readFile(full, "utf8");
    const lines = text.split("\n").length;
    if (cap.lines && lines > cap.lines) {
      issues.push({
        file: path,
        level: "error",
        rule: "size-cap",
        message: `${lines} lines; the always-on cap is ${cap.lines}`,
      });
    }
    if (cap.chars && text.length > cap.chars) {
      issues.push({
        file: path,
        level: "error",
        rule: "size-cap",
        message: `${text.length} characters; the cap is ${cap.chars}`,
      });
    }
  }

  return {
    root,
    filesChecked: textFiles.length,
    concepts,
    skills,
    issues,
    ok: !issues.some((i) => i.level === "error"),
  };
}

/**
 * Karpathy's lint pass, the parts code can check: broken links, orphan pages, source pages that
 * don't point at a raw file, sources that are missing, and an index.md that has drifted.
 * Contradictions and stale claims need judgment, so the curator checks those.
 */
const STANDALONE = new Set(["preference", "instruction", "fact"]);

async function wikiIssues(root: string): Promise<Issue[]> {
  if (!(await exists(join(root, "wiki")))) return [];
  const issues: Issue[] = [];
  const k = await loadKnowledge(root);
  const graph = linkGraph(k.concepts);
  for (const c of k.concepts) {
    const file = `wiki/${c.id}.md`;
    for (const t of graph.broken.get(c.id) ?? []) {
      issues.push({
        file,
        level: "error",
        rule: "broken-link",
        message: `links to "${t}", which is not a page (or matches more than one). Use the page id, e.g. [[projects/kb-hub]].`,
      });
    }
    // Single preferences, instructions and facts stand alone; everything else should be linked.
    if (
      !STANDALONE.has(c.meta.type) &&
      c.meta.status !== "deprecated" &&
      !graph.backlinks.get(c.id)?.length
    ) {
      issues.push({
        file,
        level: "warning",
        rule: "orphan",
        message:
          "no other page links here; link it from a related project, person, topic or source page",
      });
    }
    if (c.meta.type === "source" && !c.meta.sources.some((s) => s.resource.startsWith("raw/"))) {
      issues.push({
        file,
        level: "error",
        rule: "source-raw",
        message:
          "a source page must list the raw file it summarizes (sources: - resource: raw/...)",
      });
    }
    for (const s of c.meta.sources) {
      if (/^(raw|inbox)\//.test(s.resource) && !(await exists(join(root, s.resource)))) {
        issues.push({
          file,
          level: c.meta.type === "source" ? "error" : "warning",
          rule: "missing-source",
          message: `source ${s.resource} does not exist${s.resource.startsWith("inbox/") ? " (processed files move to raw/)" : ""}`,
        });
      }
    }
  }
  const indexFile = join(root, "wiki/index.md");
  if ((await exists(indexFile)) && (await readFile(indexFile, "utf8")) !== renderIndex(k)) {
    issues.push({
      file: "wiki/index.md",
      level: "warning",
      rule: "index-stale",
      message: "out of date with the pages; run kb index",
    });
  }
  return issues;
}
