import { readFile, writeFile } from "node:fs/promises";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import { today } from "../lib/inbox.ts";
import { ConceptFrontmatter } from "../schema/concept.ts";

export type PromoteResult = { file: string; from: string; to: string; verified: boolean };

/**
 * Run when the user approves a curator PR: every concept the PR touched gets a
 * `verified` entry from the user, and drafts become stable. This is the only code
 * path that writes `verified`, so agents can never mark their own work as reviewed.
 */
export async function promote(
  files: string[],
  by: string,
  now = new Date(),
): Promise<PromoteResult[]> {
  if (!/^human:[A-Za-z0-9-]+$/.test(by))
    throw new Error('--by must look like "human:<github-login>"');
  const out: PromoteResult[] = [];
  for (const file of files) {
    if (!file.endsWith(".md") || file.endsWith("/index.md") || file.endsWith("/log.md")) continue;
    const parsed = parseFrontmatter(await readFile(file, "utf8"));
    if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
    const meta = ConceptFrontmatter.parse(parsed.data);
    const from = meta.status;
    const to = from === "draft" ? "stable" : from;
    const day = today(now);
    const verified = [
      ...(meta.verified ?? []).filter((v) => !(v.by === by && v.at === day)),
      { by, at: day },
    ];
    const next = { ...(parsed.data as Record<string, unknown>), status: to, verified };
    await writeFile(
      file,
      `---\n${Bun.YAML.stringify(next, null, 2).trimEnd()}\n---\n${parsed.body.replace(/^\n*/, "")}`,
    );
    out.push({ file, from, to, verified: true });
  }
  return out;
}
