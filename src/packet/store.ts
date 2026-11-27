import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureRun, type Ledger, type RunRow } from "../ledger/db.ts";
import { authorOf, type Ctx } from "../lib/context.ts";
import { dirtyFiles, headCommit, tryGit } from "../lib/git.ts";
import { sanitize } from "../lib/sanitize.ts";
import { changedLines } from "./diff.ts";
import {
  CHANGES_END,
  CHANGES_START,
  formatPacket,
  parsePacketText,
  stripChanges,
} from "./format.ts";
import { extractStrikes } from "./redline.ts";
import { BATON_FIELDS, type DeadEnd, formatIssues, type Packet, PacketSchema } from "./schema.ts";

export const handoffDir = (root: string) => join(root, ".baton", "handoffs");
export const packetPath = (root: string, id: string) => join(handoffDir(root), `${id}.md`);
const historyDir = (root: string, id: string) => join(handoffDir(root), ".history", id);

export function isHandoffId(id: string): boolean {
  return /^h-\d+$/.test(id);
}

export function listIds(root: string): string[] {
  const dir = handoffDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^h-\d+\.md$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

function nextId(root: string): string {
  const ids = listIds(root);
  const last = ids.length ? Number(ids[ids.length - 1]?.slice(2)) : 0;
  return `h-${last + 1}`;
}

/**
 * Why a packet file must not be treated as a handoff, or null if it may. Packets are
 * local-only: one tracked by git (say, merged from someone else's branch) or one Baton has
 * no ledger record of is never read as a handoff, whatever its `from` says.
 */
export function untrustedReason(db: Ledger, root: string, id: string): string | null {
  const rel = relative(root, packetPath(root, id));
  if (tryGit(root, ["ls-files", "--error-unmatch", "--", rel]) !== null) {
    return `${rel} is tracked by git. Packets are local-only, so a committed packet is never read as a handoff. Remove it from git (git rm --cached ${rel}) if it is yours.`;
  }
  const row = db
    .query<{ n: number }, { repo: string; id: string }>(
      "SELECT COUNT(*) AS n FROM handoffs WHERE repo = $repo AND id = $id",
    )
    .get({ repo: root, id });
  if (!row?.n) return `${rel} was not created by Baton on this machine (no ledger record).`;
  return null;
}

export type Loaded = {
  id: string;
  path: string;
  text: string;
  data: Record<string, unknown> | null;
  body: string;
  packet: Packet | null;
  issues: string[];
};

export function loadPacket(root: string, id: string): Loaded | null {
  const path = packetPath(root, id);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const parsed = parsePacketText(text);
  if (!parsed.ok)
    return { id, path, text, data: null, body: "", packet: null, issues: [parsed.error] };
  const result = PacketSchema.safeParse(parsed.data);
  return {
    id,
    path,
    text,
    data: parsed.data,
    body: parsed.body,
    packet: result.success ? result.data : null,
    issues: result.success ? [] : formatIssues(result.error),
  };
}

/** Text compared between revisions: no rev, timestamps or generated changes block. */
function canonical(data: Record<string, unknown>, body: string): string {
  const { rev: _r, created: _c, updated: _u, ...rest } = data;
  return formatPacket(rest, stripChanges(body));
}

function latestRevision(root: string, id: string): { rev: number; text: string } | null {
  const dir = historyDir(root, id);
  if (!existsSync(dir)) return null;
  const revs = readdirSync(dir)
    .map((f) => /^rev-(\d+)\.md$/.exec(f)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const rev = revs[revs.length - 1];
  if (rev === undefined) return null;
  return { rev, text: readFileSync(join(dir, `rev-${rev}.md`), "utf8") };
}

type RevisionInput = {
  ctx: Ctx;
  db: Ledger;
  root: string;
  id: string;
  rev: number;
  text: string;
  author: string;
  diff: string[];
  struck: number;
};

function storeRevision(r: RevisionInput): void {
  const dir = historyDir(r.root, r.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rev-${r.rev}.md`), r.text);
  writeFileSync(packetPath(r.root, r.id), r.text);
  const run = r.ctx.identity.agent ? ensureRun(r.db, r.ctx.identity, "env", r.ctx.now()) : null;
  r.db
    .query(
      `INSERT OR REPLACE INTO packet_revisions (repo, handoff_id, rev, author, run_id, diff, struck, created)
       VALUES ($repo, $id, $rev, $author, $run, $diff, $struck, $now)`,
    )
    .run({
      repo: r.root,
      id: r.id,
      rev: r.rev,
      author: r.author,
      run: run?.id ?? null,
      diff: r.diff.join("\n"),
      struck: r.struck,
      now: r.ctx.now().toISOString(),
    });
}

/**
 * A packet file edited without `baton handoff edit` is recorded as a revision by "unknown",
 * so the history always matches what agents actually read.
 */
export function syncOutsideEdits(ctx: Ctx, db: Ledger, root: string, id: string): void {
  const path = packetPath(root, id);
  if (!existsSync(path) || untrustedReason(db, root, id)) return;
  const text = readFileSync(path, "utf8");
  const last = latestRevision(root, id);
  if (last && last.text === text) return;
  storeRevision({
    ctx,
    db,
    root,
    id,
    rev: (last?.rev ?? 0) + 1,
    text,
    author: "unknown",
    diff: last ? changedLines(last.text, text) : [],
    struck: 0,
  });
}

/** The run a person's "Prepare" should credit: the latest agent run seen in this repo. */
export function latestRepoRun(db: Ledger, root: string): RunRow | null {
  return db
    .query<RunRow, { repo: string }>(
      `SELECT runs.* FROM runs JOIN (
         SELECT run_id, committed AS at FROM commits WHERE repo = $repo AND run_id IS NOT NULL
         UNION ALL
         SELECT run_id, recorded AS at FROM test_results WHERE repo = $repo AND run_id IS NOT NULL
       ) seen ON seen.run_id = runs.id
       WHERE runs.vendor != 'unknown'
       ORDER BY seen.at DESC LIMIT 1`,
    )
    .get({ repo: root });
}

function filesTouched(db: Ledger, root: string, runId: number | null): string[] {
  const files = new Set(dirtyFiles(root));
  if (runId !== null) {
    const rows = db
      .query<{ path: string }, { run: number; repo: string }>(
        "SELECT DISTINCT path FROM writes WHERE run_id = $run AND repo = $repo ORDER BY path",
      )
      .all({ run: runId, repo: root });
    for (const r of rows) files.add(r.path);
  }
  return [...files].sort();
}

export type WriteResult =
  | {
      ok: true;
      id: string;
      path: string;
      rev: number;
      packet: Record<string, unknown>;
      issues: string[];
    }
  | { ok: false; issues: string[] };

/**
 * Creates a packet. Baton fills id, base_commit, dirty, from and files_touched itself.
 * With `draft`, a packet that fails validation (TODO placeholders) is written anyway.
 */
export function createPacket(
  ctx: Ctx,
  db: Ledger,
  root: string,
  input: Record<string, unknown>,
  body: string,
  opts: { draft?: boolean; fromRun?: RunRow | null } = {},
): WriteResult {
  const run = ctx.identity.agent
    ? ensureRun(db, ctx.identity, "env", ctx.now())
    : (opts.fromRun ?? null);
  const id = nextId(root);
  const now = ctx.now().toISOString();
  const data: Record<string, unknown> = { ...input };
  for (const f of BATON_FIELDS) delete data[f];
  Object.assign(data, {
    id,
    base_commit: headCommit(root) ?? "none",
    dirty: dirtyFiles(root).length > 0,
    from: {
      vendor: run?.vendor ?? "unknown",
      model: run?.model ?? "unknown",
      session: run?.session_id ?? "unknown",
    },
    files_touched: filesTouched(db, root, run?.id ?? null),
    rev: 1,
    created: now,
    updated: now,
  });
  sanitizeFields(data);
  const result = PacketSchema.safeParse(data);
  const issues = result.success ? [] : formatIssues(result.error);
  if (!result.success && !opts.draft) return { ok: false, issues };
  mkdirSync(handoffDir(root), { recursive: true });
  const text = formatPacket(data, body || defaultBody());
  storeRevision({ ctx, db, root, id, rev: 1, text, author: authorOf(ctx), diff: [], struck: 0 });
  db.query(
    `INSERT OR REPLACE INTO handoffs (id, repo, from_run, to_run, packet_path, format, created)
     VALUES ($id, $repo, $from, NULL, $path, 'baton-packet-v1', $now)`,
  ).run({ id, repo: root, from: run?.id ?? null, path: relative(root, packetPath(root, id)), now });
  return { ok: true, id, path: packetPath(root, id), rev: 1, packet: data, issues };
}

function defaultBody(): string {
  return "## Notes for the next agent\n\nWrite for a reader with zero context: what you tried, what you found, where to look.\n";
}

function sanitizeFields(data: Record<string, unknown>): void {
  if (Array.isArray(data.test_observations)) {
    data.test_observations = data.test_observations.map((o) =>
      typeof o === "string" ? sanitize(o) : o,
    );
  }
}

/**
 * Applies an edited packet (the redline). Struck `~~text~~` moves into dead_ends, Baton's own
 * fields are restored, and a "Changes since the last revision" block goes at the top of the
 * body so the next agent reads the redline first. Nothing is written if the result is invalid.
 */
export function applyEdit(
  ctx: Ctx,
  db: Ledger,
  root: string,
  id: string,
  edited: string,
): WriteResult & { changed?: boolean } {
  const untrusted = untrustedReason(db, root, id);
  if (untrusted) return { ok: false, issues: [untrusted] };
  syncOutsideEdits(ctx, db, root, id);
  const prev = loadPacket(root, id);
  if (!prev?.data) return { ok: false, issues: prev ? prev.issues : [`no packet ${id}`] };
  const { text, struck } = extractStrikes(edited);
  const parsed = parsePacketText(text);
  if (!parsed.ok) return { ok: false, issues: [parsed.error] };
  const data: Record<string, unknown> = { ...parsed.data };
  for (const f of BATON_FIELDS) data[f] = prev.data[f];
  const author = authorOf(ctx);
  const by = author === "person" ? "person" : author === "unknown" ? "unknown" : "agent";
  const deadEnds: unknown[] = Array.isArray(data.dead_ends) ? [...data.dead_ends] : [];
  for (const s of struck) {
    const who =
      by === "person" ? "the person" : by === "unknown" ? "an unidentified session" : author;
    const reason = `rejected by ${who}${s.field ? ` (was in ${s.field})` : ""}`;
    deadEnds.push({ approach: s.text, reason, by } satisfies DeadEnd);
  }
  if (deadEnds.length) data.dead_ends = deadEnds;
  const prevRev = typeof prev.data.rev === "number" ? prev.data.rev : 1;
  data.rev = prevRev + 1;
  data.created = prev.data.created;
  data.updated = ctx.now().toISOString();
  sanitizeFields(data);
  const result = PacketSchema.safeParse(data);
  if (!result.success) return { ok: false, issues: formatIssues(result.error) };

  const newDeadEnds = addedDeadEnds(prev.data.dead_ends, data.dead_ends);
  const diff = changedLines(
    canonical(withoutDeadEnds(prev.data), prev.body),
    canonical(withoutDeadEnds(data), parsed.body),
  );
  if (diff.length === 0 && newDeadEnds.length === 0) {
    return {
      ok: true,
      id,
      path: prev.path,
      rev: prevRev,
      packet: prev.data,
      issues: [],
      changed: false,
    };
  }
  const body =
    changesBlock(author, data.rev as number, newDeadEnds, diff) +
    stripChanges(parsed.body).replace(/^\n+/, "");
  const out = formatPacket(data, body);
  storeRevision({
    ctx,
    db,
    root,
    id,
    rev: data.rev as number,
    text: out,
    author,
    diff,
    struck: struck.length,
  });
  return {
    ok: true,
    id,
    path: prev.path,
    rev: data.rev as number,
    packet: data,
    issues: [],
    changed: true,
  };
}

const MAX_DIFF_LINES = 60;

const approachOf = (d: unknown): string | null =>
  typeof d === "string"
    ? d
    : d && typeof d === "object" && typeof (d as { approach?: unknown }).approach === "string"
      ? (d as { approach: string }).approach
      : null;

/** Dead ends in `after` that were not in `before`, by their approach text. */
function addedDeadEnds(before: unknown, after: unknown): string[] {
  const seen = new Set((Array.isArray(before) ? before : []).map(approachOf));
  return (Array.isArray(after) ? after : [])
    .map(approachOf)
    .filter((a): a is string => a !== null && !seen.has(a));
}

function withoutDeadEnds(data: Record<string, unknown>): Record<string, unknown> {
  const { dead_ends: _d, ...rest } = data;
  return rest;
}

function changesBlock(author: string, rev: number, deadEnds: string[], diff: string[]): string {
  const who = author === "person" ? "the person" : author;
  const lines = [CHANGES_START, `## Changes from ${who} since the last revision (rev ${rev})`, ""];
  if (deadEnds.length) {
    lines.push("New dead ends (do not retry these):", "");
    for (const d of deadEnds) lines.push(`- ${d}`);
    lines.push("");
  }
  if (diff.length) {
    const shown = diff.slice(0, MAX_DIFF_LINES);
    lines.push("Edits:", "", "```diff", ...shown);
    if (diff.length > shown.length)
      lines.push(`… ${diff.length - shown.length} more changed lines`);
    lines.push("```");
  }
  lines.push(CHANGES_END, "", "");
  return lines.join("\n");
}

/** Records that an agent picked the handoff up, linking the two sessions in the ledger. */
export function markReceived(ctx: Ctx, db: Ledger, root: string, id: string): number | null {
  if (!ctx.identity.agent) return null;
  const run = ensureRun(db, ctx.identity, "env", ctx.now());
  db.query(
    `UPDATE handoffs SET to_run = $run
     WHERE repo = $repo AND id = $id AND to_run IS NULL AND (from_run IS NULL OR from_run != $run)`,
  ).run({ run: run.id, repo: root, id });
  db.query("UPDATE runs SET role = COALESCE(role, 'receiver') WHERE id = $run").run({
    run: run.id,
  });
  return run.id;
}
