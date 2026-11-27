import type { Vendor } from "../lib/identity.ts";

/** What a headless run's JSON output tells us, normalized across vendors. */
export type ImportedRun = {
  vendor: Exclude<Vendor, "unknown">;
  session_id: string | null;
  model: string | null;
  cli_version: string | null;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  wall_ms: number | null;
  /** Absolute or repo-relative paths, as the tool events name them. */
  reads: string[];
  /** Reads guessed from shell commands (cat, sed -n, head...), stored with source "inferred". */
  inferred_reads: string[];
  writes: string[];
  /** Writes guessed from shell commands (`> file`, tee, cp, sed -i), source "inferred". */
  inferred_writes: string[];
  /** Number of tool events seen, so M0 can tell "no tools used" from "no tool events". */
  tool_events: number;
  is_error: boolean | null;
};

export class ImportError extends Error {}

/** Parses either one JSON document or JSON Lines into a list of objects. */
export function parseJsonOrLines(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportError("empty input");
  try {
    const one = JSON.parse(trimmed);
    if (Array.isArray(one)) return one.filter(isObject);
    if (isObject(one)) return [one];
  } catch {
    // Not a single document: fall through to JSON Lines.
  }
  const out: Record<string, unknown>[] = [];
  for (const [i, line] of trimmed.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (isObject(value)) out.push(value);
    } catch {
      throw new ImportError(`line ${i + 1} is not JSON`);
    }
  }
  return out;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
