import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import { ConceptFrontmatter, SkillFrontmatter } from "../schema/concept.ts";

export type Concept = {
  /** Path under wiki/ without .md, e.g. "profile/reply-length". */
  id: string;
  meta: ConceptFrontmatter;
  body: string;
  lastUpdated: string;
};

export type Skill = { name: string; description: string; dir: string; body: string };

export type Knowledge = { concepts: Concept[]; skills: Skill[]; invalid: string[] };

const RESERVED = new Set(["index", "log"]);

async function walk(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Load every valid concept and skill from a knowledge repo. Invalid files are listed, not thrown. */
export async function loadKnowledge(root: string): Promise<Knowledge> {
  const concepts: Concept[] = [];
  const skills: Skill[] = [];
  const invalid: string[] = [];
  const kdir = join(root, "wiki");

  for (const file of await walk(kdir)) {
    if (!file.endsWith(".md")) continue;
    const id = relative(kdir, file).split(sep).join("/").replace(/\.md$/, "");
    if (RESERVED.has(id)) continue;
    const parsed = parseFrontmatter(await readFile(file, "utf8"));
    const meta = parsed.ok ? ConceptFrontmatter.safeParse(parsed.data) : null;
    if (!parsed.ok || !meta?.success) {
      invalid.push(`wiki/${id}.md`);
      continue;
    }
    const mtime = (await stat(file)).mtime.toISOString();
    const dates = [meta.data.generated?.at, ...(meta.data.verified ?? []).map((v) => v.at)].filter(
      (d): d is string => !!d && d !== "unknown",
    );
    const lastUpdated = dates.sort().at(-1) ?? mtime.slice(0, 10);
    concepts.push({ id, meta: meta.data, body: parsed.body.trim(), lastUpdated });
  }

  const sdir = join(root, "skills");
  for (const file of await walk(sdir)) {
    if (!file.endsWith(`${sep}SKILL.md`)) continue;
    const parsed = parseFrontmatter(await readFile(file, "utf8"));
    const meta = parsed.ok ? SkillFrontmatter.safeParse(parsed.data) : null;
    if (!parsed.ok || !meta?.success) {
      invalid.push(relative(root, file).split(sep).join("/"));
      continue;
    }
    skills.push({
      name: meta.data.name,
      description: meta.data.description,
      dir: join(file, ".."),
      body: parsed.body,
    });
  }

  concepts.sort((a, b) => a.id.localeCompare(b.id));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { concepts, skills, invalid };
}
