import { createHash } from "node:crypto";
import { ensureRun, type Ledger } from "../ledger/db.ts";
import { type Ctx, type Outcome, UsageError } from "../lib/context.ts";
import { dirtyFiles, git, headCommit } from "../lib/git.ts";
import { DEFAULT_LIMIT_BYTES, sanitize, tailBytes } from "../lib/sanitize.ts";
import { requireRoot } from "./root.ts";

export type TestCounts = { passed: number; failed: number };

/**
 * Reads pass and fail counts from common runner summaries (bun, jest, vitest, pytest,
 * go, cargo). Falls back to the exit code: one passing or one failing "suite".
 */
export function parseCounts(output: string, exitCode: number): TestCounts {
  const last = (re: RegExp): number | null => {
    let found: number | null = null;
    for (const m of output.matchAll(re)) found = Number(m[1]);
    return found;
  };
  const passed =
    last(/^\s*(\d+) pass\b/gm) ??
    last(/Tests:.*?(\d+) passed/g) ??
    last(/Tests\s+(?:\d+ failed \| )?(\d+) passed/g) ??
    last(/(\d+) passed/g) ??
    last(/test result: \w+\. (\d+) passed/g);
  const failed =
    last(/^\s*(\d+) fail\b/gm) ??
    last(/Tests:.*?(\d+) failed/g) ??
    last(/Tests\s+(\d+) failed/g) ??
    last(/(\d+) failed/g);
  if (passed === null && failed === null) {
    return exitCode === 0 ? { passed: 1, failed: 0 } : { passed: 0, failed: 1 };
  }
  const f = failed ?? 0;
  return { passed: passed ?? 0, failed: exitCode !== 0 && f === 0 ? 1 : f };
}

/** Hash of the command and the blob ids of tracked test files: same suite, same hash. */
export function suiteHash(root: string, cmd: string[]): string {
  const files = git(root, ["ls-files", "-s"])
    .split("\n")
    .filter((l) => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/.test(l));
  return createHash("sha256")
    .update(JSON.stringify(cmd))
    .update(files.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export type TestRow = {
  id: number;
  repo: string;
  run_id: number | null;
  commit: string | null;
  dirty: number;
  cmd: string;
  exit_code: number;
  passed: number;
  failed: number;
  suite_hash: string;
  output_tail: string;
  duration_ms: number;
  recorded: string;
};

/** `baton test -- <cmd...>`: runs the command, streams its output and records the result. */
export async function runTest(
  ctx: Ctx,
  db: Ledger,
  cmd: string[],
  quiet = false,
): Promise<Outcome> {
  if (cmd.length === 0) throw new UsageError("usage: baton test -- <command> [args...]");
  const root = requireRoot(ctx);
  const commit = headCommit(root);
  const dirty = dirtyFiles(root).length > 0;
  const started = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: ctx.cwd,
    env: ctx.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const chunks: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      chunks.push(text);
      if (!quiet) sink.write(text);
    }
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  const exitCode = await proc.exited;
  const duration = Math.round(performance.now() - started);
  const output = chunks.join("");
  const counts = parseCounts(output, exitCode);
  const run = ensureRun(db, ctx.identity, "env", ctx.now());
  const row = db
    .query<TestRow, Record<string, string | number | null>>(
      `INSERT INTO test_results
        (repo, run_id, "commit", dirty, cmd, exit_code, passed, failed, suite_hash, output_tail, duration_ms, recorded)
       VALUES ($repo, $run, $commit, $dirty, $cmd, $exit, $passed, $failed, $suite, $tail, $ms, $now)
       RETURNING *`,
    )
    .get({
      repo: root,
      run: run.id,
      commit,
      dirty: dirty ? 1 : 0,
      cmd: cmd.join(" "),
      exit: exitCode,
      passed: counts.passed,
      failed: counts.failed,
      suite: suiteHash(root, cmd),
      tail: sanitize(tailBytes(output, 65536), DEFAULT_LIMIT_BYTES, "tail"),
      ms: duration,
      now: ctx.now().toISOString(),
    });
  if (!row) throw new Error("could not record the test result");
  const verdict = exitCode === 0 ? "passed" : "failed";
  const summary = `baton: test ${row.id} ${verdict} (${counts.passed} passed, ${counts.failed} failed) at ${commit?.slice(0, 7) ?? "no commit"}${dirty ? " +dirty" : ""}`;
  return {
    code: exitCode === 0 ? 0 : 1,
    data: { ...row, output_tail: undefined },
    text: summary,
  };
}
