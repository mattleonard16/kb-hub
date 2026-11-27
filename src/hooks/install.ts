import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooksDir } from "../lib/git.ts";

export const HOOK_MARKER = "# managed by baton";

/** The command a hook uses to reach Baton: this checkout's CLI, run with the current bun. */
export function defaultBatonCommand(): string {
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  if (cli.startsWith("/$bunfs/")) return shellQuote(process.execPath);
  return `${shellQuote(process.execPath)} ${shellQuote(cli)}`;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function script(batonCmd: string, args: string): string {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Records this commit in the local Baton ledger. It never blocks a commit.",
    `BATON_CMD="\${BATON_CMD:-${batonCmd.replaceAll('"', '\\"')}}"`,
    `eval "$BATON_CMD hook ${args}" >/dev/null 2>&1 || true`,
    "exit 0",
    "",
  ].join("\n");
}

export type HookResult = { hook: string; status: "installed" | "updated" | "skipped-foreign" };

/**
 * Writes prepare-commit-msg and post-commit hooks. A hook that someone else wrote is left
 * alone, and the result says so, so the person can chain Baton into it by hand.
 */
export function installHooks(root: string, batonCmd = defaultBatonCommand()): HookResult[] {
  const dir = hooksDir(root);
  mkdirSync(dir, { recursive: true });
  const hooks: Array<[string, string]> = [
    ["prepare-commit-msg", 'prepare-commit-msg "$1" "$2"'],
    ["post-commit", "post-commit"],
  ];
  return hooks.map(([name, args]) => {
    const path = join(dir, name);
    let status: HookResult["status"] = "installed";
    if (existsSync(path)) {
      if (!readFileSync(path, "utf8").includes(HOOK_MARKER)) {
        return { hook: name, status: "skipped-foreign" };
      }
      status = "updated";
    }
    writeFileSync(path, script(batonCmd, args));
    chmodSync(path, 0o755);
    return { hook: name, status };
  });
}
