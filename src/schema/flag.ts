import { z } from "zod";

/** A report from an agent that knowledge is missing, wrong or stale. Lands in inbox/flags/. */
export const FlagKind = z.enum(["missing", "wrong", "stale"]);

export const Flag = z.object({
  kind: FlagKind,
  concept_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-/]*$/, "concept_id is the file path without .md")
    .optional(),
  /** Set by the server from the authenticated client, never from tool input. */
  reported_by: z.string().min(1),
  what_happened: z.string().min(1).max(2000),
  suggested_fix: z.string().max(2000).optional(),
  at: z.iso.datetime({ offset: true }),
  idempotency_key: z.string().max(128).optional(),
});
export type Flag = z.infer<typeof Flag>;

/** Hard cap from the security plan: 4 KB per flag. */
export const MAX_FLAG_BYTES = 4 * 1024;
