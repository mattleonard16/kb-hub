import { homedir } from "node:os";
import { join } from "node:path";
import { detectIdentity, type Identity } from "./identity.ts";

/** Everything a command needs from its surroundings, so tests can supply their own. */
export type Ctx = {
  cwd: string;
  /** Directory holding the personal ledger (`~/.baton` unless BATON_HOME is set). */
  home: string;
  env: Record<string, string | undefined>;
  identity: Identity;
  /** Whether stdin is a terminal. Agent tools run commands without one. */
  interactive: boolean;
  now: () => Date;
};

export function defaultCtx(): Ctx {
  const env = process.env;
  return {
    cwd: process.cwd(),
    home: env.BATON_HOME?.trim() || join(homedir(), ".baton"),
    env,
    identity: detectIdentity(env),
    interactive: process.stdin.isTTY === true,
    now: () => new Date(),
  };
}

/**
 * The person, as far as Baton can tell: no agent harness signal, and a terminal attached.
 * Anything else with no harness signal is recorded as "unknown", never as the person.
 */
export function isPerson(ctx: Ctx): boolean {
  return !ctx.identity.agent && ctx.interactive;
}

/** Who wrote a revision or verdict: the vendor, "person", or "unknown". */
export function authorOf(ctx: Ctx): string {
  if (ctx.identity.agent) return ctx.identity.vendor;
  return isPerson(ctx) ? "person" : "unknown";
}

/** Result of a command: `data` for --json, `text` for people. */
export type Outcome = {
  code: 0 | 1 | 2;
  data: unknown;
  text: string;
};

export const ok = (data: unknown, text: string): Outcome => ({ code: 0, data, text });
export const invalid = (data: unknown, text: string): Outcome => ({ code: 1, data, text });

export class UsageError extends Error {}
