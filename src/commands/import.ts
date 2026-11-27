import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { parseClaude } from "../importers/claude.ts";
import { parseCodex } from "../importers/codex.ts";
import type { ImportedRun } from "../importers/types.ts";
import { ensureRun, type Ledger } from "../ledger/db.ts";
import { type Ctx, type Outcome, UsageError } from "../lib/context.ts";
import { repoRoot } from "../lib/git.ts";

export function parseImport(kind: string, text: string, ctx: Ctx): ImportedRun {
  if (kind === "claude" || kind === "claude-json") return parseClaude(text);
  if (kind === "codex" || kind === "codex-json")
    return parseCodex(text, { codexHome: ctx.env.CODEX_HOME });
  throw new UsageError("usage: baton import <claude|codex> <file|->");
}

/** `baton import <claude|codex> <file|->`: loads one headless run into the ledger. */
export function importRun(
  ctx: Ctx,
  db: Ledger,
  kind: string,
  file: string,
  stdin?: string,
): Outcome {
  const text = file === "-" ? (stdin ?? "") : readFileSync(file, "utf8");
  const run = parseImport(kind, text, ctx);
  if (!run.session_id) {
    return { code: 1, data: run, text: "no session id in the output, so the run can't be keyed" };
  }
  const root = repoRoot(ctx.cwd) ?? ctx.cwd;
  const now = ctx.now();
  const row = ensureRun(
    db,
    {
      vendor: run.vendor,
      model: run.model ?? "unknown",
      session_id: run.session_id,
      cli_version: run.cli_version,
      agent: true,
    },
    "headless-json",
    now,
  );
  db.transaction(() => {
    db.query(
      `UPDATE runs SET turns = $turns, input_tokens = $in, output_tokens = $out,
         cache_read_tokens = $cr, cache_write_tokens = $cw, wall_ms = COALESCE($wall, wall_ms),
         ended = COALESCE(ended, $now), identity_source = 'headless-json'
       WHERE id = $id`,
    ).run({
      turns: run.turns,
      in: run.input_tokens,
      out: run.output_tokens,
      cr: run.cache_read_tokens,
      cw: run.cache_write_tokens,
      wall: run.wall_ms,
      now: now.toISOString(),
      id: row.id,
    });
    for (const [table, paths, source] of [
      ["reads", run.reads, "json-events"],
      ["reads", run.inferred_reads, "inferred"],
      ["writes", run.writes, "json-events"],
    ] as const) {
      const insert = db.query(
        `INSERT OR IGNORE INTO ${table} (run_id, repo, path, content_hash, source)
         VALUES ($run, $repo, $path, NULL, $source)`,
      );
      for (const p of paths) {
        insert.run({ run: row.id, repo: root, path: toRepoPath(root, p), source });
      }
    }
  })();
  const text_ = `baton: imported ${run.vendor} session ${run.session_id} (model ${run.model ?? "unknown"}, ${run.turns ?? "?"} turns, ${run.reads.length} reads, ${run.writes.length} writes) as run ${row.id}`;
  return { code: 0, data: { run_id: row.id, ...run }, text: text_ };
}

function toRepoPath(root: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel;
}
