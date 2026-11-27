/**
 * Who is running this command, from harness environment signals only.
 * A value an agent types is never trusted, so there is no flag to set any of this.
 */
export type Vendor = "claude-code" | "codex" | "unknown";

export type Identity = {
  vendor: Vendor;
  model: string;
  session_id: string;
  cli_version: string | null;
  /** True when a harness signal says an agent (not the person) is running the command. */
  agent: boolean;
};

export const UNKNOWN = "unknown";

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

export function detectIdentity(env: Env = process.env): Identity {
  if (env.CLAUDECODE === "1" || nonEmpty(env.CLAUDE_CODE_SESSION_ID)) {
    return {
      vendor: "claude-code",
      model: nonEmpty(env.ANTHROPIC_MODEL) ?? UNKNOWN,
      session_id: nonEmpty(env.CLAUDE_CODE_SESSION_ID) ?? UNKNOWN,
      cli_version: nonEmpty(env.CLAUDE_CODE_VERSION) ?? null,
      agent: true,
    };
  }
  const codexSession = nonEmpty(env.CODEX_THREAD_ID) ?? nonEmpty(env.CODEX_SESSION_ID);
  if (codexSession || nonEmpty(env.CODEX_SANDBOX) || nonEmpty(env.CODEX_MANAGED_BY_NPM)) {
    return {
      vendor: "codex",
      model: nonEmpty(env.CODEX_MODEL) ?? UNKNOWN,
      session_id: codexSession ?? UNKNOWN,
      cli_version: null,
      agent: true,
    };
  }
  return {
    vendor: "unknown",
    model: UNKNOWN,
    session_id: UNKNOWN,
    cli_version: null,
    agent: false,
  };
}
