#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  type CreateFlags,
  handoffCreate,
  handoffEdit,
  handoffList,
  handoffRead,
  lint,
} from "./commands/handoff.ts";
import { importRun } from "./commands/import.ts";
import { init } from "./commands/init.ts";
import { status } from "./commands/status.ts";
import { runTest } from "./commands/test.ts";
import { accept, prepareHandoff, prepareReview } from "./desk/actions.ts";
import { digest } from "./desk/digest.ts";
import { prepareCommitMsg, recordCommit } from "./hooks/commit.ts";
import { type Ledger, openLedger } from "./ledger/db.ts";
import { type Ctx, defaultCtx, type Outcome, ok, UsageError } from "./lib/context.ts";

export const HELP = `baton: a shift-change desk and scorekeeper for agents from different vendors.
It never runs, messages or steers an agent.

  baton init [--no-hooks]                 set up .baton/, .gitignore, git hooks, agent instructions
  baton digest [--limit n]                the desk: failing tests, commits, claims, handoffs
  baton accept <card> [--reject] [--note] record your verdict on a commit (c-abc1234) or handoff (h-1)
  baton prepare handoff [fields]          write a packet pre-filled from the ledger
  baton prepare review <commit>           write a review packet with the suggested reviewer
  baton handoff create [fields|--file f]  write a packet (agents)
  baton handoff read <id>                 print a packet (records who picked it up)
  baton handoff edit <id> [--file f]      redline a packet in $EDITOR; ~~strike~~ moves to dead_ends
  baton handoff list                      list packets
  baton lint [ids...]                     validate packets (exit 1 on a missing field)
  baton test -- <cmd...>                  run tests and record the result
  baton import <claude|codex> <file|->    load headless JSON output into the ledger
  baton status                            who Baton thinks is running, and ledger counts

Fields: --goal --acceptance (repeat) --state in-progress|blocked --next --observation (repeat)
        --verify <cmd> --dead-end (repeat) --decision (repeat) --constraint (repeat) --body
Every command takes --json. Exit codes: 0 ok, 1 validation failed, 2 usage error.`;

const FIELD_OPTIONS = {
  file: { type: "string" },
  goal: { type: "string" },
  acceptance: { type: "string", multiple: true },
  state: { type: "string" },
  next: { type: "string" },
  observation: { type: "string", multiple: true },
  verify: { type: "string" },
  "dead-end": { type: "string", multiple: true },
  decision: { type: "string", multiple: true },
  constraint: { type: "string", multiple: true },
  parent: { type: "string" },
  "depends-on": { type: "string", multiple: true },
  body: { type: "string" },
} as const;

const OPTIONS = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  "no-hooks": { type: "boolean", default: false },
  limit: { type: "string" },
  reject: { type: "boolean", default: false },
  note: { type: "string" },
  editor: { type: "string" },
  ...FIELD_OPTIONS,
} as const;

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** Runs one CLI invocation. Exported so tests drive the real argument handling. */
export async function run(
  argv: string[],
  ctx: Ctx,
  db?: Ledger,
): Promise<Outcome & { json: boolean }> {
  const dash = argv.indexOf("--");
  const before = dash === -1 ? argv : argv.slice(0, dash);
  const after = dash === -1 ? [] : argv.slice(dash + 1);
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args: before,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    json = values.json;
    const [cmd, sub, ...rest] = positionals;
    if (values.help || !cmd || cmd === "help") return { ...ok(null, HELP), json };
    const ledger = () => {
      db ??= openLedger(ctx.home);
      return db;
    };
    const fields = values as CreateFlags;
    const out = await dispatch(cmd, sub, rest, after, values, fields, ctx, ledger);
    return { ...out, json };
  } catch (err) {
    if (
      err instanceof UsageError ||
      (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      return {
        code: 2,
        data: { ok: false, error: (err as Error).message },
        text: `baton: ${(err as Error).message}`,
        json,
      };
    }
    throw err;
  }
}

async function dispatch(
  cmd: string,
  sub: string | undefined,
  rest: string[],
  after: string[],
  values: {
    "no-hooks": boolean;
    limit?: string | undefined;
    reject: boolean;
    note?: string | undefined;
    editor?: string | undefined;
    file?: string | undefined;
  },
  fields: CreateFlags,
  ctx: Ctx,
  ledger: () => Ledger,
): Promise<Outcome> {
  const needStdin = async (file: string | undefined) =>
    file === "-" ? await readStdin() : undefined;
  switch (cmd) {
    case "init":
      return init(ctx, { hooks: !values["no-hooks"], batonCmd: ctx.env.BATON_CMD });
    case "digest": {
      const limit = values.limit ? Number(values.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
        throw new UsageError("--limit must be a positive integer");
      return digest(ctx, ledger(), limit);
    }
    case "accept":
      return accept(ctx, ledger(), sub, { reject: values.reject, note: values.note });
    case "prepare":
      if (sub === "handoff") return prepareHandoff(ctx, ledger(), fields);
      if (sub === "review") return prepareReview(ctx, ledger(), rest[0]);
      throw new UsageError("usage: baton prepare handoff | baton prepare review <commit>");
    case "handoff":
      switch (sub) {
        case "create":
          return handoffCreate(ctx, ledger(), fields, await needStdin(fields.file));
        case "read":
          return handoffRead(ctx, ledger(), rest[0]);
        case "edit":
          return handoffEdit(ctx, ledger(), rest[0], { file: values.file, editor: values.editor });
        case "list":
          return handoffList(ctx, ledger());
        default:
          throw new UsageError("usage: baton handoff create|read|edit|list");
      }
    case "lint":
      return lint(
        ctx,
        [sub, ...rest].filter((x): x is string => !!x),
      );
    case "test":
      return runTest(ctx, ledger(), after);
    case "import": {
      const file = rest[0];
      if (!sub || !file) throw new UsageError("usage: baton import <claude|codex> <file|->");
      return importRun(ctx, ledger(), sub, file, await needStdin(file));
    }
    case "hook":
      if (sub === "prepare-commit-msg") {
        if (!rest[0]) throw new UsageError("usage: baton hook prepare-commit-msg <file> [source]");
        return prepareCommitMsg(ctx, rest[0], rest[1]);
      }
      if (sub === "post-commit") return recordCommit(ctx, ledger());
      throw new UsageError("usage: baton hook prepare-commit-msg|post-commit");
    case "record-commit":
      return recordCommit(ctx, ledger(), sub);
    case "status":
      return status(ctx, ledger());
    case "claim":
    case "release":
    case "finding":
    case "recommend":
    case "report":
      throw new UsageError(
        `\`baton ${cmd}\` is not built yet (milestone ${cmd === "recommend" || cmd === "report" ? "M5" : "M3"})`,
      );
    default:
      throw new UsageError(`unknown command: ${cmd} (try baton help)`);
  }
}

if (import.meta.main) {
  const out = await run(process.argv.slice(2), defaultCtx());
  if (out.json) console.log(JSON.stringify(out.data, null, 2));
  else if (out.text) (out.code === 0 ? console.log : console.error)(out.text);
  process.exit(out.code);
}
