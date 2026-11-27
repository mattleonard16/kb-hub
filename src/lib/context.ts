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
  now: () => Date;
};

export function defaultCtx(): Ctx {
  const env = process.env;
  return {
    cwd: process.cwd(),
    home: env.BATON_HOME?.trim() || join(homedir(), ".baton"),
    env,
    identity: detectIdentity(env),
    now: () => new Date(),
  };
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
