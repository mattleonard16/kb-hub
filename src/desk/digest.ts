import { requireRoot } from "../commands/root.ts";
import type { TestRow } from "../commands/test.ts";
import { getRun, type Ledger, type RunRow, runLabel } from "../ledger/db.ts";
import type { Ctx, Outcome } from "../lib/context.ts";
import { listIds, loadPacket, syncOutsideEdits } from "../packet/store.ts";

export type Card =
  | {
      kind: "commit";
      card: string;
      sha: string;
      subject: string;
      by: string;
      files: number;
      tests: string;
      actions: string[];
    }
  | {
      kind: "failing-test";
      card: string;
      test_id: number;
      cmd: string;
      commit: string | null;
      failed: number;
      last_passing: string | null;
      by: string;
      actions: string[];
    }
  | {
      kind: "claim";
      card: string;
      paths: string;
      by: string;
      minutes_left: number;
      actions: string[];
    }
  | {
      kind: "handoff";
      card: string;
      state: string;
      goal: string;
      next_step: string;
      from: string;
      rev: number;
      redlines: number;
      picked_up_by: string | null;
      needs: string[];
      actions: string[];
    };

type CommitRow = {
  sha: string;
  subject: string;
  run_id: number | null;
  files: number;
  committed: string;
};

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none");

function testSummary(t: TestRow | null): string {
  if (!t) return "no tests recorded";
  return `${t.exit_code === 0 ? "passed" : "FAILED"} (${t.passed} passed, ${t.failed} failed)${t.dirty ? " on a dirty tree" : ""}`;
}

export function buildCards(ctx: Ctx, db: Ledger, root: string, limit = 10): Card[] {
  const cards: Card[] = [];
  const label = (id: number | null) => runLabel(getRun(db, id));

  const failing = db
    .query<TestRow, { repo: string }>(
      `SELECT t.* FROM test_results t
       JOIN (SELECT suite_hash, MAX(id) AS id FROM test_results WHERE repo = $repo GROUP BY suite_hash) last
         ON last.id = t.id
       WHERE t.exit_code != 0 ORDER BY t.id DESC`,
    )
    .all({ repo: root });
  for (const t of failing) {
    const lastPass = db
      .query<{ commit: string | null }, { repo: string; suite: string; id: number }>(
        `SELECT "commit" FROM test_results WHERE repo = $repo AND suite_hash = $suite
         AND exit_code = 0 AND id < $id ORDER BY id DESC LIMIT 1`,
      )
      .get({ repo: root, suite: t.suite_hash, id: t.id });
    cards.push({
      kind: "failing-test",
      card: `t-${t.id}`,
      test_id: t.id,
      cmd: t.cmd,
      commit: t.commit,
      failed: t.failed,
      last_passing: lastPass?.commit ?? null,
      by: label(t.run_id),
      actions: [
        "baton prepare handoff",
        ...(t.commit ? [`baton prepare review ${short(t.commit)}`] : []),
      ],
    });
  }

  const commits = db
    .query<CommitRow, { repo: string; limit: number }>(
      `SELECT sha, subject, run_id, files, committed FROM commits c
       WHERE repo = $repo AND NOT EXISTS (
         SELECT 1 FROM verdicts v WHERE v.repo = c.repo AND v.target_kind = 'commit' AND v.target = c.sha)
       ORDER BY committed DESC LIMIT $limit`,
    )
    .all({ repo: root, limit });
  const testFor = db.query<TestRow, { repo: string; sha: string }>(
    `SELECT * FROM test_results WHERE repo = $repo AND "commit" = $sha ORDER BY dirty ASC, id DESC LIMIT 1`,
  );
  for (const c of commits) {
    const card = `c-${short(c.sha)}`;
    cards.push({
      kind: "commit",
      card,
      sha: c.sha,
      subject: c.subject,
      by: label(c.run_id),
      files: c.files,
      tests: testSummary(testFor.get({ repo: root, sha: c.sha })),
      actions: [`baton accept ${card}`, `baton prepare review ${short(c.sha)}`],
    });
  }

  const now = ctx.now();
  const claims = db
    .query<
      { id: number; paths: string; run_id: number | null; lease_until: string },
      { repo: string; now: string }
    >(
      "SELECT id, paths, run_id, lease_until FROM claims WHERE repo = $repo AND lease_until > $now ORDER BY lease_until",
    )
    .all({ repo: root, now: now.toISOString() });
  for (const c of claims) {
    cards.push({
      kind: "claim",
      card: `l-${c.id}`,
      paths: c.paths,
      by: label(c.run_id),
      minutes_left: Math.max(0, Math.round((Date.parse(c.lease_until) - now.getTime()) / 60000)),
      actions: [],
    });
  }

  for (const id of listIds(root)) {
    const accepted = db
      .query<{ n: number }, { repo: string; id: string }>(
        "SELECT COUNT(*) AS n FROM verdicts WHERE repo = $repo AND target_kind = 'handoff' AND target = $id",
      )
      .get({ repo: root, id });
    if (accepted && accepted.n > 0) continue;
    syncOutsideEdits(ctx, db, root, id);
    const p = loadPacket(root, id);
    const d = p?.data ?? {};
    const h = db
      .query<{ to_run: number | null }, { repo: string; id: string }>(
        "SELECT to_run FROM handoffs WHERE repo = $repo AND id = $id",
      )
      .get({ repo: root, id });
    const redlines = db
      .query<{ n: number }, { repo: string; id: string }>(
        "SELECT COUNT(*) AS n FROM packet_revisions WHERE repo = $repo AND handoff_id = $id AND rev > 1 AND author = 'person'",
      )
      .get({ repo: root, id });
    const from = typeof d.from === "object" && d.from ? (d.from as Record<string, unknown>) : {};
    const receiver: RunRow | null = getRun(db, h?.to_run ?? null);
    cards.push({
      kind: "handoff",
      card: id,
      state: String(d.state ?? "?"),
      goal: String(d.goal ?? ""),
      next_step: String(d.next_step ?? ""),
      from: from.vendor && from.vendor !== "unknown" ? `${from.vendor}:${from.model}` : "unknown",
      rev: typeof d.rev === "number" ? d.rev : 1,
      redlines: redlines?.n ?? 0,
      picked_up_by: receiver ? runLabel(receiver) : null,
      needs: p?.issues ?? [],
      actions: [`baton handoff edit ${id}`, `baton accept ${id}`],
    });
  }
  return cards;
}

function render(card: Card): string {
  const act = card.actions.length ? `\n    → ${card.actions.join("   ")}` : "";
  switch (card.kind) {
    case "failing-test":
      return `✗ FAILING  ${card.card}  ${card.cmd}\n    ${card.failed} failed at ${short(card.commit)} by ${card.by}; last passed at ${short(card.last_passing)}${act}`;
    case "commit":
      return `● COMMIT   ${card.card}  ${card.subject}\n    by ${card.by}, ${card.files} files, tests ${card.tests}${act}`;
    case "claim":
      return `◆ CLAIM    ${card.card}  ${card.paths}\n    held by ${card.by}, ${card.minutes_left} min left`;
    case "handoff": {
      const status = card.picked_up_by ? `picked up by ${card.picked_up_by}` : "waiting";
      const needs = card.needs.length ? `\n    needs: ${card.needs.join("; ")}` : "";
      return `▶ HANDOFF  ${card.card}  ${card.goal || "(no goal yet)"}\n    ${card.state}, rev ${card.rev}, from ${card.from}, ${card.redlines} redlines, ${status}\n    next: ${card.next_step || "(none)"}${needs}${act}`;
    }
  }
}

/** `baton digest`: the Newsroom Desk. Failing tests first, then commits, claims, handoffs. */
export function digest(ctx: Ctx, db: Ledger, limit?: number): Outcome {
  const root = requireRoot(ctx);
  const cards = buildCards(ctx, db, root, limit);
  const text = cards.length
    ? cards.map(render).join("\n\n")
    : "baton: the desk is clear (no commits, failing tests, claims or handoffs waiting)";
  return { code: 0, data: { repo: root, cards }, text };
}
