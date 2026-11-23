import { shortHash, today } from "../lib/inbox.ts";
import { findInjection } from "../lib/injection.ts";
import { findSecrets } from "../lib/secrets.ts";
import type { InboxSink } from "../lib/sinks.ts";

/** What a raw source is. The curator writes one summary page per source (Karpathy's "ingest"). */
export const SOURCE_KINDS = [
  "email",
  "transcript",
  "chat",
  "note",
  "doc",
  "repo",
  "terminal",
  "slack",
  "article",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const MAX_SOURCE_BYTES = 1024 * 1024;
const TEXT_EXT = /^(md|txt|eml|json|jsonl|yaml|yml|csv|vtt|srt|html|log)$/;

export type SourceResult = {
  path: string;
  created: boolean;
  kind: SourceKind;
  bytes: number;
  /** Instruction-like patterns found; the curator must not copy those parts into the wiki. */
  injection: string[];
};

export function isSourceKind(v: string | undefined): v is SourceKind {
  return !!v && (SOURCE_KINDS as readonly string[]).includes(v);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "untitled"
  );
}

/**
 * Queue any source document (an email, a meeting transcript, notes, a repo README, a terminal
 * session, a Slack thread, an article) for the curator, stored byte for byte. Metadata lives in
 * the file name, `sources/<date>-<kind>-<hash>-<slug>.<ext>`, so the raw text is never altered.
 * Text containing a secret is refused: raw sources are committed and kept forever.
 */
export async function addSource(
  sink: InboxSink,
  text: string,
  opts: { kind: SourceKind; title: string; ext?: string; now?: Date },
): Promise<SourceResult> {
  const bytes = new TextEncoder().encode(text).length;
  if (!text.trim()) throw new Error("source is empty");
  if (bytes > MAX_SOURCE_BYTES)
    throw new Error(
      `source is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}. Split it or trim it.`,
    );
  const secrets = findSecrets(text);
  if (secrets.length)
    throw new Error(
      `source contains a possible secret (${secrets.join(", ")}). Remove it first; raw sources are kept forever.`,
    );
  const ext = (opts.ext ?? "md").toLowerCase().replace(/^\./, "");
  const safeExt = TEXT_EXT.test(ext) ? ext : "txt";
  const name = `sources/${today(opts.now)}-${opts.kind}-${shortHash(text)}-${slug(opts.title)}.${safeExt}`;
  const w = await sink.put(name, text);
  return { ...w, kind: opts.kind, bytes, injection: findInjection(text) };
}
