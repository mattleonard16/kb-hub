import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { CreateFlags } from "../commands/handoff.ts";
import { requireRoot } from "../commands/root.ts";
import type { TestRow } from "../commands/test.ts";
import { getRun, type Ledger, runLabel } from "../ledger/db.ts";
import { type Ctx, invalid, isPerson, type Outcome, ok, UsageError } from "../lib/context.ts";
import { git, tryGit } from "../lib/git.ts";
import { sanitize } from "../lib/sanitize.ts";
import { formatPacket } from "../packet/format.ts";
import { createPacket, isHandoffId, latestRepoRun } from "../packet/store.ts";

/**
 * `baton accept <card>`: the person's verdict on a commit or a handoff. Refused inside an
 * agent session, because an agent grading its own work is exactly what the ledger avoids.
 */
export function accept(
  ctx: Ctx,
  db: Ledger,
  card: string | undefined,
  opts: { reject?: boolean; note?: string | undefined } = {},
): Outcome {
  if (!card) throw new UsageError("usage: baton accept <card> [--reject] [--note text]");
  if (!isPerson(ctx)) {
    return invalid(
      { ok: false, reason: ctx.identity.agent ? "agent-session" : "no-terminal" },
      "baton: accept records the person's verdict, so it only runs in your own terminal, not inside an agent session or a script.",
    );
  }
  const root = requireRoot(ctx);
  let kind: "commit" | "handoff";
  let target: string;
  if (isHandoffId(card)) {
    kind = "handoff";
    target = card;
    const exists = db
      .query<{ n: number }, { repo: string; id: string }>(
        "SELECT COUNT(*) AS n FROM handoffs WHERE repo = $repo AND id = $id",
      )
      .get({ repo: root, id: card });
    if (!exists?.n) return invalid({ ok: false }, `baton: no handoff ${card}`);
  } else {
    const prefix = card.replace(/^c-/, "");
    if (!/^[0-9a-f]{4,40}$/.test(prefix)) throw new UsageError(`not a card id: ${card}`);
    const rows = db
      .query<{ sha: string }, { repo: string; p: string }>(
        "SELECT sha FROM commits WHERE repo = $repo AND sha LIKE $p",
      )
      .all({ repo: root, p: `${prefix}%` });
    if (rows.length !== 1) {
      return invalid(
        { ok: false },
        rows.length ? `baton: ${card} is ambiguous` : `baton: no recorded commit ${card}`,
      );
    }
    kind = "commit";
    target = rows[0]?.sha ?? "";
  }
  const accepted = !opts.reject;
  db.query(
    `INSERT INTO verdicts (repo, target_kind, target, accepted, note, recorded)
     VALUES ($repo, $kind, $target, $accepted, $note, $now)`,
  ).run({
    repo: root,
    kind,
    target,
    accepted: accepted ? 1 : 0,
    note: opts.note ?? null,
    now: ctx.now().toISOString(),
  });
  return ok(
    { ok: true, kind, target, accepted },
    `baton: ${accepted ? "accepted" : "rejected"} ${kind} ${kind === "commit" ? target.slice(0, 7) : target}`,
  );
}

function lastTest(db: Ledger, root: string): TestRow | null {
  return db
    .query<TestRow, { repo: string }>(
      "SELECT * FROM test_results WHERE repo = $repo ORDER BY id DESC LIMIT 1",
    )
    .get({ repo: root });
}

function observationFrom(t: TestRow): string {
  const tail = t.output_tail
    .split("\n")
    .filter((l) => l.trim())
    .slice(-8)
    .join("\n");
  return sanitize(
    `\`${t.cmd}\` ${t.exit_code === 0 ? "passed" : "failed"} (${t.passed} passed, ${t.failed} failed) at ${t.commit?.slice(0, 7) ?? "no commit"}${t.dirty ? " with uncommitted changes" : ""}.\n${tail}`,
    1024,
  );
}

/**
 * `baton prepare handoff`: writes a packet pre-filled from the ledger, with TODO placeholders
 * for what only a person or agent can say. It never contacts an agent; it prints the line
 * for the person to give one.
 */
export function prepareHandoff(ctx: Ctx, db: Ledger, flags: CreateFlags): Outcome {
  const root = requireRoot(ctx);
  const test = lastTest(db, root);
  const data: Record<string, unknown> = {
    goal: flags.goal ?? "TODO: what the next agent should achieve",
    state: flags.state ?? "in-progress",
    acceptance: flags.acceptance?.length ? flags.acceptance : ["TODO: a checkable criterion"],
    next_step: flags.next ?? "TODO: the first thing the next agent should do",
    test_observations: flags.observation?.length
      ? flags.observation
      : test
        ? [observationFrom(test)]
        : ["TODO: what the tests showed (no `baton test` run recorded yet)"],
  };
  const verify = flags.verify ?? test?.cmd;
  if (verify) data.verify_cmd = verify;
  if (flags["dead-end"]?.length) data.dead_ends = flags["dead-end"];
  if (flags.decision?.length) data.decisions = flags.decision;
  if (flags.constraint?.length) data.constraints = flags.constraint;
  const result = createPacket(ctx, db, root, data, flags.body ?? "", {
    draft: true,
    fromRun: latestRepoRun(db, root),
  });
  if (!result.ok) return invalid({ ok: false, issues: result.issues }, result.issues.join("\n"));
  const rel = relative(root, result.path);
  const todo = result.issues.length > 0;
  const lines = [`baton: wrote ${rel}`];
  if (todo) lines.push(`Fill in the TODO fields first: baton handoff edit ${result.id}`);
  lines.push(`Then give the next agent: Read ${rel} and continue.`);
  return ok(
    {
      ok: true,
      id: result.id,
      path: rel,
      needs: result.issues,
      instruction: `Read ${rel} and continue.`,
    },
    lines.join("\n"),
  );
}

const OTHER_VENDOR: Record<string, string> = { "claude-code": "codex", codex: "claude-code" };

/**
 * `baton prepare review <commit>`: writes a review packet with the suggested reviewer,
 * verify_cmd and evidence rule, and prints the line for the person to give the reviewer.
 */
export function prepareReview(ctx: Ctx, db: Ledger, commit: string | undefined): Outcome {
  if (!commit) throw new UsageError("usage: baton prepare review <commit>");
  const root = requireRoot(ctx);
  const sha = tryGit(root, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]);
  if (!sha) return invalid({ ok: false }, `baton: no commit ${commit}`);
  const row = db
    .query<{ run_id: number | null }, { sha: string }>(
      "SELECT run_id FROM commits WHERE sha = $sha",
    )
    .get({ sha });
  const author = getRun(db, row?.run_id ?? null);
  const test =
    db
      .query<TestRow, { repo: string; sha: string }>(
        `SELECT * FROM test_results WHERE repo = $repo AND "commit" = $sha ORDER BY id DESC LIMIT 1`,
      )
      .get({ repo: root, sha }) ?? lastTest(db, root);
  const suggested = author
    ? (OTHER_VENDOR[author.vendor] ?? "any other vendor")
    : "any agent that did not write it";
  const subject = git(root, ["log", "-1", "--format=%s", sha]);
  const files = git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha])
    .split("\n")
    .filter(Boolean);
  const id = `r-${sha.slice(0, 7)}`;
  const dir = join(root, ".baton", "reviews");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  const data: Record<string, unknown> = {
    id,
    kind: "review",
    commit: sha,
    subject,
    author: runLabel(author),
    suggested_reviewer: suggested,
    suggestion_basis: "default rule (a different vendor): the blind-spot map has no data yet",
    verify_cmd: test?.cmd ?? "TODO: the command that runs the tests",
    files,
    evidence_rule:
      "Each finding must point to a failing test you ran with `baton test -- <cmd>` in your own session. A finding without one is not counted.",
    created: ctx.now().toISOString(),
  };
  const body = [
    "## How to review",
    "",
    `1. Read the change: \`git show ${sha.slice(0, 7)}\`.`,
    "2. For each suspected defect, write or run a test that shows it, through `baton test -- <cmd>`.",
    "3. List findings below: file, line, the claim, and the `baton test` result id that shows it.",
    "",
    "## Findings",
    "",
  ].join("\n");
  writeFileSync(path, formatPacket(data, body));
  const rel = relative(root, path);
  const instruction = `Read ${rel} and review commit ${sha.slice(0, 7)}.`;
  return ok(
    { ok: true, id, path: rel, suggested_reviewer: suggested, instruction },
    `baton: wrote ${rel}\nSuggested reviewer: ${suggested} (${data.suggestion_basis})\nGive the reviewer: ${instruction}`,
  );
}
