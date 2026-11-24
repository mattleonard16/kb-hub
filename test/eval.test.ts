import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadEval, runEval } from "../src/eval/search-eval.ts";
import { loadKnowledge } from "../src/index/load.ts";
import { KnowledgeStore } from "../src/index/store.ts";
import { lintKnowledge } from "../src/lint/lint.ts";
import { quiet, tempDir, tempKnowledge } from "./helpers.ts";

describe("kb eval", () => {
  test("scores each question by where its page ranks", async () => {
    const root = await tempKnowledge();
    const cases = (await loadEval(root)) ?? [];
    const store = new KnowledgeStore(await loadKnowledge(root));
    const local = runEval(store, cases, ["public", "personal", "sensitive"]);
    expect(local).toMatchObject({ cases: 4, hit1: 1, hit3: 1, mrr: 1, misses: [], unknown: [] });
    // The hosted server never serves sensitive pages, so that question has no answer there.
    const hosted = runEval(store, cases, ["public", "personal"]);
    expect(hosted.hit1).toBe(0.75);
    expect(hosted.unknown).toEqual([{ q: "what does the peanut page say?", id: "health/allergy" }]);
  });

  test("the CLI fails on a missing page or a score under --min, and passes an empty file", async () => {
    const root = await tempKnowledge();
    expect(await quiet(() => main(["eval", "--dir", root, "--min", "0.9"]))).toBe(0);
    expect(await quiet(() => main(["eval", "--dir", root, "--hosted"]))).toBe(1);
    await writeFile(
      join(root, "evals/search.yaml"),
      "- q: what is the weather on mars?\n  expect: profile/reply-length\n",
    );
    expect(await quiet(() => main(["eval", "--dir", root]))).toBe(0);
    expect(await quiet(() => main(["eval", "--dir", root, "--min", "0.5"]))).toBe(1);
    expect(quiet(() => main(["eval", "--dir", root, "--min", "2"]))).rejects.toThrow("--min");

    const fresh = join(await tempDir(), "knowledge");
    expect(await quiet(() => main(["init", fresh]))).toBe(0);
    expect(await quiet(() => main(["eval", "--dir", fresh, "--min", "0.8"]))).toBe(0);
  });

  test("lint reports a question whose page was renamed, and a malformed file", async () => {
    const root = await tempKnowledge();
    await writeFile(
      join(root, "evals/search.yaml"),
      "- q: how long should my replies be?\n  expect: profile/reply-size\n",
    );
    const issues = (await lintKnowledge(root)).issues.filter((i) => i.file === "evals/search.yaml");
    expect(issues.map((i) => i.rule)).toEqual(["eval-target"]);
    await writeFile(join(root, "evals/search.yaml"), "- question: missing fields\n");
    const bad = (await lintKnowledge(root)).issues.filter((i) => i.file === "evals/search.yaml");
    expect(bad.map((i) => i.rule)).toEqual(["eval-format"]);
  });
});
