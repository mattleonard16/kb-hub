import { z } from "zod";
import { Confidence, IsoDate, LooseDate, Origin, Scope } from "./common.ts";

/**
 * Frontmatter of one concept file in `wiki/`.
 * OKF-compatible: OKF only requires `type`; we require more so the curator and
 * compilers can rely on it. Unknown keys are kept (OKF allows them).
 */
export const ConceptType = z.enum([
  // Profile and entity pages: one fact each, and the only ones that can become always-on.
  "preference",
  "fact",
  "project",
  "person",
  "tool",
  "data_source",
  "instruction",
  // Karpathy's other wiki pages: a summary of one raw source, a concept or topic that many
  // sources touch, and a synthesis (comparison, overview, an answer worth keeping).
  "source",
  "concept",
  "synthesis",
  // Code and team knowledge: a repo's map, one module (folder or package) of it, a feature that
  // spans modules, a decision record (why it is built this way), and a lesson from a past problem.
  "repo",
  "module",
  "feature",
  "decision",
  "lesson",
]);
export type ConceptType = z.infer<typeof ConceptType>;

/** Page types that may be compiled into always-on files. */
export const PROFILE_TYPES: ReadonlySet<string> = new Set([
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

/** Short repo name, as used by `kb scan --name` and `kb stale --repo <name>=<dir>`. */
export const RepoName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "repo must be a short lowercase name, e.g. my-app");

/** A git commit: 7 to 40 hex characters. */
export const Commit = z.string().regex(/^[0-9a-f]{7,40}$/, "commit must be a git sha");

/** A list of short lines. One string is accepted too (solutions docs often write one), as a list of one. */
const Lines = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((v) => (typeof v === "string" ? [v] : v));

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
  // Where the truth lives, as in OKF. With `repo`, a path inside that repo; otherwise a URL.
  resource: z.string().min(1).optional(),
  repo: RepoName.optional(),
  /** The commit `resource` was read at. `kb stale --repo` flags the page once that path changes. */
  commit: Commit.optional(),
  /** On a repo page: docs `kb coverage` should never list, as paths or globs (`docs/*-demo-*`). */
  ignore: z.array(z.string().min(1)).optional(),
  // Lessons: when they apply and what the problem looks like, so a search for the symptom finds them.
  applies_when: Lines.optional(),
  symptoms: Lines.optional(),
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
    PROFILE_TYPES.has(c.type) &&
    c.scope === "global" &&
    c.status === "stable" &&
    c.confidence === "high" &&
    c.sensitivity !== "sensitive" &&
    (c.verified?.some((v) => v.by.startsWith("human:")) ?? false)
  );
}
