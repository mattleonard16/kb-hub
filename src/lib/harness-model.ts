import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Identity } from "./identity.ts";

type Env = Record<string, string | undefined>;

const SAFE_ID = /^[A-Za-z0-9-]+$/;
const TAIL_BYTES = 512 * 1024;

/** The last `"model":"..."` in the end of a file, or null. Only the tail is read. */
function lastModel(path: string, pattern: RegExp): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    let found: string | null = null;
    for (const m of buf.toString("utf8").matchAll(pattern)) found = m[1] ?? found;
    return found;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function firstFile(root: string, pattern: string): string | null {
  try {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      return join(root, rel);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The model a live session is using, read from the session file its harness writes
 * (Claude Code: `~/.claude/projects/<dir>/<session>.jsonl`; Codex:
 * `~/.codex/sessions/.../rollout-*<thread>.jsonl`). These are written by the harness, not
 * typed by the agent, so they count as a harness signal. Null if nothing is found.
 */
export function modelFromSessionFile(id: Identity, env: Env): string | null {
  if (!SAFE_ID.test(id.session_id)) return null;
  if (id.vendor === "claude-code") {
    const root = join(
      env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME ?? homedir(), ".claude"),
      "projects",
    );
    const file = firstFile(root, `*/${id.session_id}.jsonl`);
    return file ? lastModel(file, /"model"\s*:\s*"(claude-[^"]+)"/g) : null;
  }
  if (id.vendor === "codex") {
    const root = env.CODEX_HOME?.trim() || join(env.HOME ?? homedir(), ".codex");
    const file = firstFile(root, `sessions/**/rollout-*${id.session_id}.jsonl`);
    return file ? lastModel(file, /"model"\s*:\s*"([^"]+)"/g) : null;
  }
  return null;
}

/** Fills in an unknown model from the harness's session file, when there is one. */
export function withSessionModel(id: Identity, env: Env): Identity {
  if (!id.agent || id.model !== "unknown") return id;
  const model = modelFromSessionFile(id, env);
  return model ? { ...id, model } : id;
}
