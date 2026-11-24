import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { KnowledgeStore } from "../index/store.ts";
import { ConceptType, type Sensitivity } from "../schema/concept.ts";

/**
 * `kb eval`: questions an agent would really ask, each with the page that should answer it.
 * It scores search the way agents use it, so a ranking change or a renamed page that makes the
 * wiki harder to use fails a check instead of going unnoticed.
 */

export const EVAL_FILE = "evals/search.yaml";

export const EvalCase = z.object({
  q: z.string().min(1).max(200),
  /** The page that should come first; a list means any of them. */
  expect: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  type: ConceptType.optional(),
  scope: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;
export const EvalFile = z.array(EvalCase);

export type EvalMiss = { q: string; expect: string[]; rank: number | null; got: string[] };
export type EvalResult = {
  cases: number;
  hit1: number;
  hit3: number;
  /** Mean reciprocal rank over the first 8 results. */
  mrr: number;
  misses: EvalMiss[];
  /** Expected ids that are not pages: a renamed or deleted page, or a typo. */
  unknown: Array<{ q: string; id: string }>;
};

export async function loadEval(root: string, file = EVAL_FILE): Promise<EvalCase[] | null> {
  let text: string;
  try {
    text = await readFile(join(root, file), "utf8");
  } catch {
    return null;
  }
  const parsed = EvalFile.safeParse(Bun.YAML.parse(text) ?? []);
  if (!parsed.success)
    throw new Error(
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

export function runEval(
  store: KnowledgeStore,
  cases: EvalCase[],
  allowed: Sensitivity[],
): EvalResult {
  let hit1 = 0;
  let hit3 = 0;
  let rr = 0;
  const misses: EvalMiss[] = [];
  const unknown: EvalResult["unknown"] = [];
  for (const c of cases) {
    const expect = typeof c.expect === "string" ? [c.expect] : c.expect;
    for (const id of expect) if (!store.get(id, allowed)) unknown.push({ q: c.q, id });
    const got = store
      .search(c.q, { allowed, type: c.type, scope: c.scope }, 8)
      .results.map((r) => r.id);
    const i = got.findIndex((id) => expect.includes(id));
    if (i === 0) hit1++;
    if (i >= 0 && i < 3) hit3++;
    if (i >= 0) rr += 1 / (i + 1);
    if (i !== 0) misses.push({ q: c.q, expect, rank: i >= 0 ? i + 1 : null, got: got.slice(0, 3) });
  }
  const n = cases.length || 1;
  return {
    cases: cases.length,
    hit1: hit1 / n,
    hit3: hit3 / n,
    mrr: rr / n,
    misses,
    unknown,
  };
}
