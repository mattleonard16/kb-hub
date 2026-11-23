import { z } from "zod";
import { Confidence, LooseDate, Origin, Scope, Tool } from "./common.ts";

/** The YAML an assistant returns when given prompts/extract/base.md. */
export const ExtractionItemKind = z.enum([
  "preference",
  "fact",
  "project",
  "procedure",
  "data_source",
  "instruction",
  "person",
]);

export const ExtractionItem = z.object({
  kind: ExtractionItemKind,
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(4000),
  scope: Scope.default("global"),
  origin: Origin,
  saved_at: LooseDate.default("unknown"),
  confidence: Confidence.default("medium"),
});
export type ExtractionItem = z.infer<typeof ExtractionItem>;

export const ExtractionExport = z.object({
  export: z.object({
    tool: Tool,
    prompt_version: z.number().int().positive(),
    exported_at: LooseDate,
    complete: z.boolean().default(false),
  }),
  items: z.array(ExtractionItem).default([]),
  gaps: z.array(z.string()).default([]),
});
export type ExtractionExport = z.infer<typeof ExtractionExport>;
