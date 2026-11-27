import { ImportError, type ImportedRun, isObject, num, parseJsonOrLines, str } from "./types.ts";

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Reads `claude -p --output-format json` (one result object) or
 * `--output-format stream-json --verbose` (JSON Lines with tool events).
 */
export function parseClaude(text: string): ImportedRun {
  const events = parseJsonOrLines(text);
  const result = events.findLast((e) => e.type === "result");
  if (!result) throw new ImportError("no result event: is this claude -p JSON output?");
  const init = events.find((e) => e.type === "system" && e.subtype === "init");

  const reads = new Set<string>();
  const writes = new Set<string>();
  let toolEvents = 0;
  let streamModel: string | null = null;
  for (const e of events) {
    if (e.type !== "assistant" || !isObject(e.message)) continue;
    streamModel ??= str(e.message.model);
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_use") continue;
      toolEvents++;
      const name = str(block.name) ?? "";
      const input = isObject(block.input) ? block.input : {};
      const path = str(input.file_path) ?? str(input.notebook_path);
      if (!path) continue;
      if (READ_TOOLS.has(name)) reads.add(path);
      if (WRITE_TOOLS.has(name)) writes.add(path);
    }
  }

  const usage = isObject(result.usage) ? result.usage : {};
  return {
    vendor: "claude-code",
    session_id: str(result.session_id) ?? (init ? str(init.session_id) : null),
    model: primaryModel(result.modelUsage) ?? (init ? str(init.model) : null) ?? streamModel,
    cli_version: init ? str(init.claude_code_version) : null,
    turns: num(result.num_turns),
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cache_read_tokens: num(usage.cache_read_input_tokens),
    cache_write_tokens: num(usage.cache_creation_input_tokens),
    wall_ms: num(result.duration_ms),
    reads: [...reads],
    writes: [...writes],
    tool_events: toolEvents,
    is_error: typeof result.is_error === "boolean" ? result.is_error : null,
  };
}

/** The model that produced the most output tokens (subagents may use smaller models). */
function primaryModel(modelUsage: unknown): string | null {
  if (!isObject(modelUsage)) return null;
  let best: string | null = null;
  let bestOut = -1;
  for (const [model, u] of Object.entries(modelUsage)) {
    const out = isObject(u) ? (num(u.outputTokens) ?? 0) : 0;
    if (out > bestOut) {
      best = model;
      bestOut = out;
    }
  }
  return best;
}
