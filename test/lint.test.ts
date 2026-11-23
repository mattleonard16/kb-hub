import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { lintKnowledge } from "../src/lint/lint.ts";
import { fixtureDir, quiet } from "./helpers.ts";

describe("kb lint", () => {
  test("valid knowledge repo passes", async () => {
    const r = await lintKnowledge(fixtureDir("knowledge-valid"));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.concepts).toBe(7);
    expect(r.skills).toBe(1);
  });

  test("invalid repo reports each rule", async () => {
    const r = await lintKnowledge(fixtureDir("knowledge-invalid"));
    expect(r.ok).toBe(false);
    const rules = new Set(r.issues.map((i) => i.rule));
    for (const rule of [
      "frontmatter",
      "concept-schema",
      "no-secrets",
      "log-format",
      "broken-link",
      "skill-schema",
      "skill-name",
      "size-cap",
    ]) {
      expect(rules.has(rule)).toBe(true);
    }
  });

  test("missing knowledge folder gives an actionable error", async () => {
    const r = await lintKnowledge(fixtureDir("."));
    expect(r.issues[0]?.message).toContain("KB_KNOWLEDGE_DIR");
  });

  test("CLI exit codes: 0 ok, 1 lint errors, usage errors throw", async () => {
    expect(await quiet(() => main(["lint", fixtureDir("knowledge-valid"), "--json"]))).toBe(0);
    expect(await quiet(() => main(["lint", fixtureDir("knowledge-invalid")]))).toBe(1);
    await expect(main(["nope"])).rejects.toThrow("Unknown command");
    await expect(main(["prompt", "notatool"])).rejects.toThrow("Unknown tool");
  });
});
