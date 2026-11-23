import { unzipSync } from "fflate";
import { shortHash, today, writeInbox } from "../lib/inbox.ts";
import type { InboxSink } from "../lib/sinks.ts";
import type { Tool } from "../schema/common.ts";
import { type IngestParse, parseReply } from "./parse.ts";

export type IngestResult = IngestParse & { path: string; created: boolean; source: string };

/** Parse a pasted reply and store it in inbox/ as normalized YAML. Idempotent by content. */
export async function ingestReply(
  sink: InboxSink,
  reply: string,
  opts: { tool?: Tool; source?: string; reportedBy?: string; now?: Date } = {},
): Promise<IngestResult> {
  const parsed = parseReply(reply, opts.tool);
  const now = opts.now ?? new Date();
  const record = {
    ingest: {
      tool: parsed.tool,
      source: opts.source ?? "paste",
      reported_by: opts.reportedBy ?? "cli",
      ingested_at: now.toISOString(),
      prompt_version: parsed.prompt_version,
      exported_at: parsed.exported_at,
      complete: parsed.complete,
      errors: parsed.errors,
      dropped: parsed.dropped,
    },
    items: parsed.items,
    gaps: parsed.gaps,
  };
  const name = `${today(now)}-${parsed.tool}-${shortHash(reply)}.yaml`;
  const { path, created } = await sink.put(name, Bun.YAML.stringify(record, null, 2));
  return { ...parsed, path, created, source: record.ingest.source };
}

export type ZipResult = {
  tool: Tool;
  dir: string;
  files: string[];
  skipped: string[];
  conversations: number | null;
};

const MAX_FILE_BYTES = 512 * 1024 * 1024;

/**
 * Store the JSON files from a ChatGPT or Claude data export under inbox/exports/.
 * Mining conversations for knowledge is the curator's job, not this command's.
 */
export async function ingestZip(
  root: string,
  zip: Uint8Array,
  tool: Tool,
  now = new Date(),
): Promise<ZipResult> {
  const entries = unzipSync(zip, {
    filter: (f) => f.name.toLowerCase().endsWith(".json") && f.originalSize <= MAX_FILE_BYTES,
  });
  const dir = `exports/${today(now)}-${tool}-${shortHash(String(zip.length) + Object.keys(entries).join())}`;
  const files: string[] = [];
  const skipped: string[] = [];
  let conversations: number | null = null;
  for (const [name, bytes] of Object.entries(entries)) {
    const safe = name
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p && p !== ".." && p !== ".")
      .join("/");
    if (!safe) {
      skipped.push(name);
      continue;
    }
    const w = await writeInbox(root, `${dir}/${safe}`, bytes);
    files.push(w.path);
    if (safe.endsWith("conversations.json")) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (Array.isArray(parsed)) conversations = parsed.length;
      } catch {
        skipped.push(`${name} (not valid JSON)`);
      }
    }
  }
  return { tool, dir: `inbox/${dir}`, files, skipped, conversations };
}
