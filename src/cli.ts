#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { lintKnowledge } from "./lint/lint.ts";

const HELP = `kb — personal knowledge hub

Usage: kb <command> [options]

Commands:
  lint [dir]      Validate a knowledge repo (default: $KB_KNOWLEDGE_DIR or ../knowledge)
  help            Show this help

Coming in later milestones: ingest (M2), index, serve (M4), compile, sync, status (M5).

Options:
  --json          Machine-readable output (every command supports it)
  -h, --help      Show help
`;

const PLANNED: Record<string, string> = {
  ingest: "M2",
  index: "M4",
  serve: "M4",
  compile: "M5",
  sync: "M5",
  status: "M5",
  audit: "M6",
  revoke: "M6",
  lockdown: "M6",
};

function knowledgeDir(arg?: string): string {
  return resolve(arg ?? process.env.KB_KNOWLEDGE_DIR ?? "../knowledge");
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "help", ...rest] = positionals;

  if (values.help || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "lint") {
    const result = await lintKnowledge(knowledgeDir(rest[0]));
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const i of result.issues)
        console.log(`${i.level.padEnd(7)} ${i.file}  [${i.rule}] ${i.message}`);
      const errors = result.issues.filter((i) => i.level === "error").length;
      const warnings = result.issues.length - errors;
      console.log(
        `\n${result.ok ? "ok" : "failed"}: ${result.concepts} concepts, ${result.skills} skills, ${errors} errors, ${warnings} warnings`,
      );
    }
    return result.ok ? 0 : 1;
  }

  const milestone = PLANNED[command];
  const message = milestone
    ? `kb ${command} is not built yet (planned for ${milestone}).`
    : `Unknown command "${command}". Run kb help to see commands.`;
  if (values.json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(message);
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}

export { main };
