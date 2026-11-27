import { readFileSync, writeFileSync } from "node:fs";
import { requireRoot } from "../commands/root.ts";
import { ensureRun, type Ledger } from "../ledger/db.ts";
import type { Ctx, Outcome } from "../lib/context.ts";
import { diffHash, filesInCommit, git, headCommit } from "../lib/git.ts";

export const TRAILER_ASSISTED = "Assisted-by";
export const TRAILER_SESSION = "Baton-Session";

/**
 * prepare-commit-msg: adds `Assisted-by` and `Baton-Session` trailers when a harness signal
 * says an agent is committing. A commit by the person gets no trailers.
 */
export function prepareCommitMsg(ctx: Ctx, msgFile: string, source?: string): Outcome {
  const id = ctx.identity;
  if (!id.agent || source === "merge" || source === "squash") {
    return { code: 0, data: { added: false }, text: "" };
  }
  const root = requireRoot(ctx);
  const original = readFileSync(msgFile, "utf8");
  const trailers = [
    `${TRAILER_ASSISTED}: ${id.vendor}:${id.model}`,
    `${TRAILER_SESSION}: ${id.vendor}/${id.session_id}`,
  ];
  const args = ["interpret-trailers", "--if-exists", "replace"];
  for (const t of trailers) args.push("--trailer", t);
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdin: new TextEncoder().encode(original),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) writeFileSync(msgFile, proc.stdout.toString());
  return { code: 0, data: { added: proc.exitCode === 0, trailers }, text: "" };
}

/** Parses `Baton-Session: <vendor>/<session>` out of a commit's trailers. */
export function sessionFromTrailers(trailers: string): { vendor: string; session: string } | null {
  const m = new RegExp(`^${TRAILER_SESSION}:\\s*([^/\\s]+)/(\\S+)\\s*$`, "m").exec(trailers);
  if (!m?.[1] || !m[2]) return null;
  return { vendor: m[1], session: m[2] };
}

export function modelFromTrailers(trailers: string): string | null {
  const m = new RegExp(`^${TRAILER_ASSISTED}:\\s*[^:\\s]+:(\\S+)\\s*$`, "m").exec(trailers);
  return m?.[1] ?? null;
}

/**
 * post-commit (and `baton record-commit <sha>`): records the commit, its diff hash and the
 * files it changed. The run comes from the commit's trailers, then from the environment.
 */
export function recordCommit(ctx: Ctx, db: Ledger, sha?: string): Outcome {
  const root = requireRoot(ctx);
  const target = sha ?? headCommit(root);
  if (!target) return { code: 0, data: null, text: "" };
  const full = git(root, ["rev-parse", target]);
  const trailers = git(root, ["log", "-1", "--format=%(trailers:unfold)", full]);
  const subject = git(root, ["log", "-1", "--format=%s", full]);
  const committed = git(root, ["log", "-1", "--format=%cI", full]);
  const fromTrailer = sessionFromTrailers(trailers);
  let runId: number | null = null;
  if (ctx.identity.agent) {
    runId = ensureRun(db, ctx.identity, "env", ctx.now()).id;
  } else if (fromTrailer) {
    // A trailer is text anyone can type into a commit message, so it only links the commit
    // to a run Baton already saw from a harness signal (env or headless JSON), never makes one.
    const known = db
      .query<{ id: number }, { vendor: string; session: string }>(
        `SELECT id FROM runs WHERE vendor = $vendor AND session_id = $session
         AND identity_source IN ('env', 'headless-json')`,
      )
      .get({ vendor: fromTrailer.vendor, session: fromTrailer.session });
    runId = known?.id ?? null;
  }
  const files = filesInCommit(root, full);
  db.transaction(() => {
    db.query(
      `INSERT INTO commits (sha, repo, run_id, diff_hash, files, subject, committed)
       VALUES ($sha, $repo, $run, $hash, $files, $subject, $committed)
       ON CONFLICT (sha) DO UPDATE SET run_id = COALESCE(excluded.run_id, commits.run_id)`,
    ).run({
      sha: full,
      repo: root,
      run: runId,
      hash: diffHash(root, full),
      files: files.length,
      subject,
      committed,
    });
    if (runId !== null) {
      const insert = db.query(
        `INSERT OR IGNORE INTO writes (run_id, repo, path, content_hash, source)
         VALUES ($run, $repo, $path, NULL, 'git')`,
      );
      for (const path of files) insert.run({ run: runId, repo: root, path });
    }
  })();
  return { code: 0, data: { sha: full, run_id: runId, files }, text: "" };
}
