import { z } from "zod";

/** Fields Baton fills itself. Whatever an agent or editor writes there is overwritten. */
export const BATON_FIELDS = ["id", "base_commit", "dirty", "from", "files_touched"] as const;

/** A value still holding a placeholder from `baton prepare handoff`. */
export const TODO = /^\s*TODO\b/;

const text = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .refine((s) => !TODO.test(s), "still a TODO placeholder");

const deadEnd = z.union([
  text.transform((approach) => ({ approach, by: "agent" as const })),
  z.object({
    approach: text,
    reason: z.string().optional(),
    by: z.enum(["agent", "person", "unknown"]).default("agent"),
  }),
]);

export const PacketSchema = z
  .object({
    id: z.string().regex(/^h-\d+$/, "must look like h-1"),
    goal: text,
    acceptance: z.array(text).min(1, "needs at least one checkable criterion"),
    state: z.enum(["in-progress", "blocked"]),
    base_commit: z.string().regex(/^([0-9a-f]{40}|none)$/, "must be a full sha or none"),
    dirty: z.boolean(),
    from: z.object({
      vendor: z.string().min(1),
      model: z.string().min(1),
      session: z.string().min(1),
    }),
    files_touched: z.array(z.string()),
    test_observations: z.array(text).min(1, "say what tests showed, or that none ran"),
    next_step: text,
    verify_cmd: text.optional(),
    dead_ends: z.array(deadEnd).optional(),
    decisions: z.array(text).optional(),
    constraints: z.array(text).optional(),
    parent: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
    rev: z.number().int().min(1).default(1),
    created: z.string().optional(),
    updated: z.string().optional(),
  })
  .strict();

export type Packet = z.output<typeof PacketSchema>;
export type DeadEnd = NonNullable<Packet["dead_ends"]>[number];

/** Field order for writing packets, so diffs between revisions stay small. */
export const FIELD_ORDER: Array<keyof Packet> = [
  "id",
  "goal",
  "state",
  "acceptance",
  "next_step",
  "verify_cmd",
  "test_observations",
  "dead_ends",
  "decisions",
  "constraints",
  "parent",
  "depends_on",
  "base_commit",
  "dirty",
  "from",
  "files_touched",
  "rev",
  "created",
  "updated",
];

/** zod issues as "field: message" lines. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const missing = i.code === "invalid_type" && / received undefined$/.test(i.message);
    return `${i.path.join(".") || "(packet)"}: ${missing ? "required" : i.message}`;
  });
}
