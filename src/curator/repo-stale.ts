import { existsSync } from "node:fs";
import { join } from "node:path";

export type RepoStale = { id: string; title: string; repo: string; reason: string; head: string };

type Page = {
  id: string;
  meta: { title: string; status: string; repo?: string; resource?: string; commit?: string };
};

function git(dir: string, args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

/**
 * Pages that describe a repo (`repo`, `resource`, `commit`) and may no longer match it: the path
 * changed since the recorded commit, or it is gone. `repos` maps repo names to local checkouts.
 */
export function repoStale(pages: Page[], repos: Map<string, string>): RepoStale[] {
  const out: RepoStale[] = [];
  const heads = new Map<string, string | null>();
  for (const p of pages) {
    const { repo, resource, commit, status } = p.meta;
    if (!repo || status === "deprecated") continue;
    const dir = repos.get(repo);
    if (!dir) continue;
    if (!heads.has(repo)) {
      const h = git(dir, ["rev-parse", "HEAD"]);
      heads.set(repo, h.code === 0 ? h.out : null);
    }
    const head = heads.get(repo);
    if (!head) throw new Error(`${dir} is not a git checkout (needed for --repo ${repo}=...)`);
    const base = { id: p.id, title: p.meta.title, repo, head };
    if (resource && !existsSync(join(dir, resource))) {
      out.push({ ...base, reason: `${resource} no longer exists` });
      continue;
    }
    if (!commit || head.startsWith(commit)) continue;
    const diff = git(dir, ["diff", "--quiet", commit, head, "--", ...(resource ? [resource] : [])]);
    if (diff.code === 1)
      out.push({
        ...base,
        reason: `${resource ?? "the repo"} changed since ${commit.slice(0, 7)}`,
      });
    else if (diff.code !== 0)
      out.push({
        ...base,
        reason: `commit ${commit.slice(0, 7)} is not in this checkout (fetch more history)`,
      });
  }
  return out;
}

/** `my-app=../my-app` pairs from `--repo`. */
export function parseRepoArgs(values: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of values) {
    const i = v.indexOf("=");
    if (i < 1 || i === v.length - 1) throw new Error(`--repo takes <name>=<dir>, got "${v}"`);
    m.set(v.slice(0, i), v.slice(i + 1));
  }
  return m;
}
