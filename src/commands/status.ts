import { join } from "node:path";
import type { Ledger } from "../ledger/db.ts";
import { type Ctx, type Outcome, ok } from "../lib/context.ts";
import { repoRoot } from "../lib/git.ts";

const TABLES = [
  "runs",
  "commits",
  "test_results",
  "handoffs",
  "packet_revisions",
  "verdicts",
] as const;

/** `baton status`: the identity Baton detected and how much the ledger holds. */
export function status(ctx: Ctx, db: Ledger): Outcome {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    counts[t] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
  }
  const id = ctx.identity;
  const data = {
    identity: id,
    repo: repoRoot(ctx.cwd),
    ledger: ctx.home === ":memory:" ? ":memory:" : join(ctx.home, "ledger.sqlite"),
    counts,
  };
  const text = [
    `identity: ${id.agent ? `${id.vendor} model=${id.model} session=${id.session_id}` : "the person (no agent harness detected)"}`,
    `repo:     ${data.repo ?? "(not in a git repo)"}`,
    `ledger:   ${data.ledger}`,
    `counts:   ${TABLES.map((t) => `${t}=${counts[t]}`).join(" ")}`,
  ].join("\n");
  return ok(data, text);
}
