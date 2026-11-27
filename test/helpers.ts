import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Ledger, openLedger } from "../src/ledger/db.ts";
import type { Ctx } from "../src/lib/context.ts";
import { detectIdentity } from "../src/lib/identity.ts";

export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export function tempDir(prefix = "baton-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Environment with every harness signal removed, so tests start as "the person". */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CLAUDE|CODEX|ANTHROPIC_MODEL|AI_AGENT|BATON_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    ...extra,
  };
}

export const CLAUDE_ENV = {
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "sess-claude-1",
  ANTHROPIC_MODEL: "claude-opus-5-5",
};
export const CODEX_ENV = { CODEX_THREAD_ID: "thread-codex-1", CODEX_MODEL: "gpt-5.5-codex" };

export function sh(cwd: string, cmd: string[], env: Record<string, string> = cleanEnv()) {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A git repo with one commit. */
export function tempRepo(): string {
  const dir = tempDir("baton-repo-");
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  sh(dir, ["git", "add", "."]);
  sh(dir, ["git", "commit", "-qm", "init"]);
  return dir;
}

export function ctxFor(cwd: string, extraEnv: Record<string, string> = {}, home = ":memory:"): Ctx {
  const env = cleanEnv(extraEnv);
  let t = Date.parse("2026-11-27T12:00:00Z");
  const now = () => {
    t += 1000;
    return new Date(t);
  };
  return { cwd, home, env, identity: detectIdentity(env), now };
}

export function memLedger(): Ledger {
  return openLedger(":memory:");
}
