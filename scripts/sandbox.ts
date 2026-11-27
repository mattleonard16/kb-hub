/**
 * Creates a small practice repo for a first real handoff (Claude Code to Codex, with one
 * redline), so the try-out never touches a real project:
 *
 *   bun run sandbox ~/code/baton-sandbox
 *
 * It copies examples/sandbox, makes one commit, and runs `baton init` there.
 * Nothing here runs an agent.
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(Bun.argv[2] ?? "baton-sandbox");
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} already exists and is not empty. Pick another folder.`);
  process.exit(2);
}
cpSync(resolve(import.meta.dir, "../examples/sandbox"), target, { recursive: true });

const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: target, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    console.error(`${cmd.join(" ")} failed:\n${p.stderr.toString()}`);
    process.exit(1);
  }
  return p.stdout.toString().trim();
};
run(["git", "init", "-q"]);
run(["git", "add", "."]);
run([
  "git",
  "-c",
  "user.name=baton",
  "-c",
  "user.email=baton@example.com",
  "commit",
  "-qm",
  "Practice task: parseDuration",
]);
console.log(run([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "init"]));
console.log(`\nPractice repo ready at ${target}. The task is in TASK.md.`);
