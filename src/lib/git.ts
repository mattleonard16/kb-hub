import { createHash } from "node:crypto";

export class GitError extends Error {}

/** Runs git and returns trimmed stdout; throws GitError on a non-zero exit. */
export function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new GitError(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().replace(/\n$/, "");
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

/** HEAD's sha, or null in a repo with no commits yet. */
export function headCommit(root: string): string | null {
  return tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
}

/** Paths with uncommitted changes (staged, unstaged or untracked), relative to the root. */
export function dirtyFiles(root: string): string[] {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files: string[] = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) i++;
  }
  return files.filter((f) => !f.startsWith(".baton/"));
}

export function filesInCommit(root: string, sha: string): string[] {
  const out = git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", sha]);
  return out.split("\0").filter(Boolean);
}

/** sha256 of the commit's patch, so two commits with the same change hash the same. */
export function diffHash(root: string, sha: string): string {
  const patch = git(root, ["diff-tree", "-p", "--root", "--no-commit-id", sha]);
  return createHash("sha256").update(patch).digest("hex");
}

/** The hooks directory git actually uses (respects core.hooksPath and worktrees). */
export function hooksDir(root: string): string {
  const dir = git(root, ["rev-parse", "--git-path", "hooks"]);
  return dir.startsWith("/") ? dir : `${root}/${dir}`;
}
