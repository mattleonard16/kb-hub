import { z } from "zod";
import { Confidence, IsoDate, LooseDate, Origin, Scope } from "./common.ts";

/**
 * Frontmatter of one concept file in `knowledge/`.
 * OKF-compatible: OKF only requires `type`; we require more so the curator and
 * compilers can rely on it. Unknown keys are kept (OKF allows them).
 */
export const ConceptType = z.enum([
  "preference",
  "fact",
  "project",
  "person",
  "tool",
  "data_source",
  "instruction",
]);

export const Status = z.enum(["draft", "stable", "deprecated"]);
export type Status = z.infer<typeof Status>;

/** public: fine anywhere. personal: hosted server with scope. sensitive: local only, never hosted. */
export const Sensitivity = z.enum(["public", "personal", "sensitive"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const Actor = z.object({
  by: z.string().min(1),
  at: LooseDate,
});

export const Source = z.object({
  id: z.string().min(1).optional(),
  resource: z.string().min(1),
  origin: Origin.optional(),
  author: z.string().optional(),
  last_modified: LooseDate.optional(),
});

export const ConceptFrontmatter = z.looseObject({
  type: ConceptType,
  title: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
  scope: Scope,
  status: Status,
  sensitivity: Sensitivity,
  confidence: Confidence,
  stale_after: IsoDate.optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(Source).min(1, "every concept needs at least one source"),
  generated: Actor.optional(),
  verified: z.array(Actor).optional(),
});
export type ConceptFrontmatter = z.infer<typeof ConceptFrontmatter>;

/** SKILL.md frontmatter (Agent Skills format). */
export const SkillFrontmatter = z.looseObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "skill name must be kebab-case")
    .max(64),
  description: z.string().min(1).max(1024),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

/** Always-on rule: only these concepts may be compiled into CLAUDE.md, AGENTS.md or custom instructions. */
export function isAlwaysOn(c: ConceptFrontmatter): boolean {
  return (
    c.scope === "global" &&
    c.status === "stable" &&
    c.confidence === "high" &&
    c.sensitivity !== "sensitive" &&
    (c.verified?.some((v) => v.by.startsWith("human:")) ?? false)
  );
}
