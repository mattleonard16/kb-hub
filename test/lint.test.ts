import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { lintKnowledge } from "../src/lint/lint.ts";

const dir = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("kb lint", () => {
  test("valid knowledge repo passes", async () => {
    const r = await lintKnowledge(dir("knowledge-valid"));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.concepts).toBe(1);
    expect(r.skills).toBe(1);
  });

  test("invalid repo reports each rule", async () => {
    const r = await lintKnowledge(dir("knowledge-invalid"));
    expect(r.ok).toBe(false);
    const rules = new Set(r.issues.map((i) => i.rule));
    for (const rule of [
      "frontmatter",
      "concept-schema",
      "no-secrets",
      "okf-log",
      "skill-schema",
      "size-cap",
    ]) {
      expect(rules.has(rule)).toBe(true);
    }
  });

  test("missing knowledge folder gives an actionable error", async () => {
    const r = await lintKnowledge(dir("."));
    expect(r.issues[0]?.message).toContain("KB_KNOWLEDGE_DIR");
  });

  test("CLI exit codes: 0 ok, 1 lint errors, 2 unknown or unbuilt command", async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await main(["lint", dir("knowledge-valid"), "--json"])).toBe(0);
      expect(await main(["lint", dir("knowledge-invalid")])).toBe(1);
      expect(await main(["serve"])).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
    }
  });
});
