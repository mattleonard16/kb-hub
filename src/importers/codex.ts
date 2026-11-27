import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ImportError, type ImportedRun, isObject, num, parseJsonOrLines, str } from "./types.ts";

/**
 * Reads `codex exec --json` JSON Lines. Those events carry the thread id, token usage and
 * file changes. If they do not name the model, it is looked up in the session's rollout file
 * under `$CODEX_HOME/sessions` (written by Codex itself, so it is a harness signal).
 */
export function parseCodex(
  text: string,
  opts: { codexHome?: string | undefined } = {},
): ImportedRun {
  const events = parseJsonOrLines(text);
  if (!events.some((e) => typeof e.type === "string" && /^(thread|turn|item)\./.test(e.type))) {
    throw new ImportError("no thread/turn/item events: is this codex exec --json output?");
  }
  let sessionId: string | null = null;
  let model: string | null = null;
  let turns = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let sawUsage = false;
  let toolEvents = 0;
  let isError = false;
  const writes = new Set<string>();

  for (const e of events) {
    model ??= str(e.model);
    if (e.type === "thread.started") sessionId ??= str(e.thread_id);
    if (e.type === "turn.completed") {
      turns++;
      if (isObject(e.usage)) {
        sawUsage = true;
        input += num(e.usage.input_tokens) ?? 0;
        cached += num(e.usage.cached_input_tokens) ?? 0;
        output += num(e.usage.output_tokens) ?? 0;
      }
    }
    if (e.type === "turn.failed" || e.type === "error") isError = true;
    if (e.type === "item.completed" && isObject(e.item)) {
      const item = e.item;
      if (
        item.type === "command_execution" ||
        item.type === "file_change" ||
        item.type === "mcp_tool_call"
      ) {
        toolEvents++;
      }
      if (item.type === "file_change" && Array.isArray(item.changes)) {
        for (const c of item.changes) {
          const path = isObject(c) ? str(c.path) : null;
          if (path) writes.add(path);
        }
      }
    }
  }

  if (!model && sessionId) model = modelFromRollout(sessionId, opts.codexHome);

  return {
    vendor: "codex",
    session_id: sessionId,
    model,
    cli_version: null,
    turns: turns || null,
    input_tokens: sawUsage ? input : null,
    output_tokens: sawUsage ? output : null,
    cache_read_tokens: sawUsage ? cached : null,
    cache_write_tokens: null,
    wall_ms: null,
    reads: [],
    writes: [...writes],
    tool_events: toolEvents,
    is_error: isError,
  };
}

/** Finds `rollout-*<thread id>.jsonl` and returns the first `"model"` it records. */
export function modelFromRollout(threadId: string, codexHome?: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) return null;
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const glob = new Bun.Glob(`sessions/**/rollout-*${threadId}.jsonl`);
  try {
    for (const rel of glob.scanSync({ cwd: home, onlyFiles: true })) {
      const text = readFileSync(join(home, rel), "utf8");
      const m = /"model"\s*:\s*"([^"]+)"/.exec(text);
      if (m?.[1]) return m[1];
    }
  } catch {
    return null;
  }
  return null;
}
