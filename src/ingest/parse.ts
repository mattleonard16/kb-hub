import { findInjection } from "../lib/injection.ts";
import { findSecrets } from "../lib/secrets.ts";
import { type Tool, Tool as ToolSchema } from "../schema/common.ts";
import { type ExtractionItem, ExtractionItem as ItemSchema } from "../schema/extraction.ts";

export const MAX_INGEST_BYTES = 64 * 1024;

export type ParsedItem = ExtractionItem & { flags?: string[] };

export type IngestParse = {
  tool: Tool;
  prompt_version: number | null;
  exported_at: string;
  complete: boolean;
  items: ParsedItem[];
  gaps: string[];
  errors: string[];
  dropped: Array<{ title: string; reason: string }>;
  recovered: boolean;
};

/** A fenced block, or a final fence left open by a truncated reply. */
const FENCED = /```(?:ya?ml)?[^\n]*\n([\s\S]*?)(?:```|$(?![\s\S]))/gi;
const PART_LINE = /^\s*(part\s+\d+\s*(of|\/)\s*\d+|\(\d+\/\d+\))\s*:?\s*$/i;

/** Pull YAML out of an assistant reply: every fenced block, joined (handles split replies). */
export function extractYaml(reply: string): string {
  const blocks = [...reply.matchAll(FENCED)].map((m) => m[1] ?? "");
  const raw = blocks.length ? blocks.join("\n") : reply;
  return raw
    .split("\n")
    .filter((l) => !PART_LINE.test(l))
    .join("\n");
}

/** Parse YAML, dropping trailing lines until it parses (truncated replies). */
function parseTolerant(yaml: string): { data: unknown; recovered: boolean; error?: string } {
  const lines = yaml.split("\n");
  let firstError: string | undefined;
  for (let cut = lines.length; cut > 0; cut--) {
    try {
      const data = Bun.YAML.parse(lines.slice(0, cut).join("\n"));
      return { data, recovered: cut < lines.length, error: firstError };
    } catch (err) {
      firstError ??= (err as Error).message;
      if (lines.length - cut > 40) break;
    }
  }
  return { data: null, recovered: false, error: firstError ?? "empty reply" };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Turn a pasted extraction reply into validated items. Never throws on bad input:
 * invalid items are reported in `errors`, items with secrets are dropped, and
 * instruction-like items are kept but flagged for the curator.
 */
export function parseReply(reply: string, toolHint?: Tool): IngestParse {
  const errors: string[] = [];
  const dropped: IngestParse["dropped"] = [];
  if (new TextEncoder().encode(reply).length > MAX_INGEST_BYTES) {
    throw new Error(
      `reply is larger than ${MAX_INGEST_BYTES / 1024} KB; split it and ingest each part`,
    );
  }

  const { data, recovered, error } = parseTolerant(extractYaml(reply));
  if (error && !data) errors.push(`could not parse YAML: ${error}`);
  else if (recovered) errors.push("reply looked truncated; parsed what was complete");

  const doc = asRecord(data);
  const header = asRecord(doc.export);
  const toolParsed = ToolSchema.safeParse(header.tool);
  const tool = toolHint ?? (toolParsed.success ? toolParsed.data : undefined);
  if (!tool)
    throw new Error(
      "unknown tool: pass --tool (claude-code, codex, chatgpt, gemini, claude, muse, instinct, dots, duet)",
    );
  if (toolHint && toolParsed.success && toolParsed.data !== toolHint) {
    errors.push(`reply says tool ${toolParsed.data}, recorded as ${toolHint}`);
  }

  const items: ParsedItem[] = [];
  const rawItems = Array.isArray(doc.items) ? doc.items : [];
  rawItems.forEach((raw, i) => {
    const r = ItemSchema.safeParse(raw);
    const title = String(asRecord(raw).title ?? `item ${i + 1}`);
    if (!r.success) {
      errors.push(
        `item ${i + 1} (${title}): ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
      );
      return;
    }
    const text = `${r.data.title}\n${r.data.content}`;
    const secrets = findSecrets(text);
    if (secrets.length) {
      dropped.push({ title, reason: `possible secret (${secrets.join(", ")})` });
      return;
    }
    const inj = findInjection(text);
    items.push(inj.length ? { ...r.data, flags: inj.map((n) => `injection:${n}`) } : r.data);
  });

  const gaps = (Array.isArray(doc.gaps) ? doc.gaps : []).filter(
    (g): g is string => typeof g === "string",
  );
  const version = Number(header.prompt_version);

  return {
    tool,
    prompt_version: Number.isInteger(version) && version > 0 ? version : null,
    exported_at: typeof header.exported_at === "string" ? header.exported_at : "unknown",
    complete: header.complete === true && !recovered,
    items,
    gaps,
    errors,
    dropped,
    recovered,
  };
}
