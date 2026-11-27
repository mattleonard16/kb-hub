/**
 * M0 day-one check: do `claude -p` and `codex exec --json` report what the ledger needs
 * (model, session, tokens, turns, tool events) on your own login, and does a commit the agent
 * makes land in the ledger under the same session? Run it yourself:
 *
 *   bun run m0              # every CLI found on PATH
 *   bun run m0 --claude     # just one
 *   bun run m0 --out dir    # where raw outputs go (default ./m0-results)
 *
 * Each CLI gets one tiny task in a throwaway git repo: read a file, write one, commit it.
 * That costs one short session on your plan. Nothing here uses an API key.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseImport } from "../src/commands/import.ts";
import { openLedger } from "../src/ledger/db.ts";
import { detectIdentity } from "../src/lib/identity.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    claude: { type: "boolean", default: false },
    codex: { type: "boolean", default: false },
    out: { type: "string", default: "m0-results" },
  },
});

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const BATON_CMD = `'${process.execPath}' '${CLI}'`;
const PROMPT =
  "Read note.txt. Create hello.txt containing exactly the word in note.txt. Then run: git add hello.txt && git commit -m 'add hello'. Reply with done.";

type Vendor = "claude" | "codex";
const COMMANDS: Record<Vendor, string[]> = {
  claude: [
    "claude",
    "-p",
    PROMPT,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    "Read,Write,Bash(git add:*),Bash(git commit:*)",
  ],
  codex: ["codex", "exec", "--json", "--full-auto", PROMPT],
};

/** The run's environment with this shell's own agent signals removed. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      !/^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|CODEX_SESSION_ID)$/.test(k)
    )
      env[k] = v;
  }
  return { ...env, BATON_HOME: home, BATON_CMD };
}

function git(cwd: string, args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

type Check = { name: string; ok: boolean; value: string };

async function check(vendor: Vendor, outDir: string): Promise<Check[]> {
  const repo = mkdtempSync(join(tmpdir(), `baton-m0-${vendor}-`));
  const home = join(repo, ".baton-home");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "m0@example.com"]);
  git(repo, ["config", "user.name", "baton m0"]);
  writeFileSync(join(repo, "note.txt"), "baton\n");
  writeFileSync(join(repo, ".gitignore"), ".baton-home/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  const init = Bun.spawnSync([process.execPath, CLI, "init"], { cwd: repo, env: cleanEnv(home) });
  if (init.exitCode !== 0) throw new Error(`baton init failed: ${init.stderr}`);

  console.log(`\n${vendor}: running one short task in ${repo} ...`);
  const started = performance.now();
  const proc = Bun.spawn(COMMANDS[vendor], {
    cwd: repo,
    env: cleanEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const wall = Math.round(performance.now() - started);
  writeFileSync(join(outDir, `${vendor}-output.jsonl`), stdout);
  if (stderr.trim()) writeFileSync(join(outDir, `${vendor}-stderr.txt`), stderr);

  const checks: Check[] = [{ name: "exit code", ok: code === 0, value: String(code) }];
  let run: ReturnType<typeof parseImport> | null = null;
  try {
    run = parseImport(vendor, stdout, {
      cwd: repo,
      home,
      env: process.env,
      identity: detectIdentity({}),
      now: () => new Date(),
    });
  } catch (err) {
    checks.push({ name: "output parses", ok: false, value: (err as Error).message });
    return checks;
  }
  const has = (v: unknown) => v !== null && v !== undefined && v !== "unknown";
  checks.push(
    { name: "session id", ok: has(run.session_id), value: String(run.session_id) },
    { name: "model", ok: has(run.model), value: String(run.model) },
    { name: "input tokens", ok: has(run.input_tokens), value: String(run.input_tokens) },
    { name: "output tokens", ok: has(run.output_tokens), value: String(run.output_tokens) },
    { name: "turns", ok: has(run.turns), value: String(run.turns) },
    { name: "tool events", ok: run.tool_events > 0, value: String(run.tool_events) },
    {
      name: "read set from events",
      ok: run.reads.length > 0,
      value: run.reads.join(", ") || "none",
    },
    {
      name: "write set from events",
      ok: run.writes.length > 0,
      value: run.writes.join(", ") || "none",
    },
    { name: "wall time (runner)", ok: true, value: `${run.wall_ms ?? wall} ms` },
  );

  const imp = Bun.spawnSync(
    [process.execPath, CLI, "import", vendor, join(outDir, `${vendor}-output.jsonl`)],
    {
      cwd: repo,
      env: cleanEnv(home),
    },
  );
  checks.push({
    name: "baton import",
    ok: imp.exitCode === 0,
    value: imp.stdout.toString().trim() || imp.stderr.toString().trim(),
  });

  const trailers = git(repo, ["log", "-1", "--format=%(trailers)"]);
  checks.push({
    name: "commit trailers",
    ok: trailers.includes("Baton-Session"),
    value: trailers.replace(/\n/g, " | ") || "none",
  });
  const db = openLedger(home);
  const linked = db
    .query<{ vendor: string; session_id: string; model: string }, []>(
      "SELECT runs.vendor, runs.session_id, runs.model FROM commits JOIN runs ON runs.id = commits.run_id ORDER BY committed DESC LIMIT 1",
    )
    .get();
  checks.push({
    name: "hook commit joins the same run",
    ok: !!linked && linked.session_id === run.session_id,
    value: linked
      ? `${linked.vendor} ${linked.session_id} model=${linked.model}`
      : "no linked commit",
  });
  db.close();
  return checks;
}

const which = (bin: string) => Bun.which(bin) !== null;
const picked: Vendor[] =
  values.claude || values.codex
    ? (["claude", "codex"] as const).filter((v) => values[v])
    : ["claude", "codex"];
const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });

const report: Record<string, Check[] | string> = {};
for (const vendor of picked) {
  if (!which(vendor)) {
    report[vendor] = `${vendor} is not on PATH`;
    console.log(`\n${vendor}: not installed, skipped`);
    continue;
  }
  const checks = await check(vendor, outDir);
  report[vendor] = checks;
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(32)} ${c.value}`);
}
writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nRaw outputs and report.json are in ${outDir}. Nothing was sent anywhere.`);
