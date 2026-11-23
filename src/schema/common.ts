import { z } from "zod";

/** YYYY-MM-DD. YAML dates arrive as strings under Bun.YAML. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected a date like 2026-11-22");

/** A date, a full ISO timestamp, or "unknown". */
export const LooseDate = z.union([IsoDate, z.iso.datetime({ offset: true }), z.literal("unknown")]);

/** global | project:<slug> | tool:<name>[:<sub>] */
export const Scope = z
  .string()
  .regex(
    /^(global|project:[a-z0-9][a-z0-9-]*|tool:[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?)$/,
    "scope must be global, project:<slug>, or tool:<name>",
  );

export const Confidence = z.enum(["high", "medium", "low"]);

/** Where an item came from inside the source tool. */
export const Origin = z.enum([
  "memory",
  "custom_instructions",
  "project_files",
  "inferred_from_chats",
]);

/** The nine assistants v1 ingests from. */
export const Tool = z.enum([
  "claude-code",
  "codex",
  "chatgpt",
  "gemini",
  "claude",
  "muse",
  "instinct",
  "dots",
  "duet",
]);
export type Tool = z.infer<typeof Tool>;
