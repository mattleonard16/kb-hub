import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/lib/frontmatter.ts";
import { findSecrets } from "../src/lib/secrets.ts";
import { ConceptFrontmatter, ExtractionExport, Flag, isAlwaysOn } from "../src/schema/index.ts";

const fixture = (p: string) => Bun.file(new URL(`./fixtures/${p}`, import.meta.url)).text();

describe("concept schema", () => {
  test("valid concept parses and is always-on", async () => {
    const doc = parseFrontmatter(await fixture("knowledge-valid/wiki/profile/reply-length.md"));
    if (!doc.ok) throw new Error(doc.error);
    const concept = ConceptFrontmatter.parse(doc.data);
    expect(concept.type).toBe("preference");
    expect(isAlwaysOn(concept)).toBe(true);
  });

  test("unverified or sensitive concepts are never always-on", async () => {
    const doc = parseFrontmatter(await fixture("knowledge-valid/wiki/profile/reply-length.md"));
    if (!doc.ok) throw new Error(doc.error);
    const base = ConceptFrontmatter.parse(doc.data);
    expect(isAlwaysOn({ ...base, verified: undefined })).toBe(false);
    expect(isAlwaysOn({ ...base, sensitivity: "sensitive" })).toBe(false);
    expect(isAlwaysOn({ ...base, status: "draft" })).toBe(false);
  });

  test("unknown keys are kept (OKF allows them)", () => {
    const parsed = ConceptFrontmatter.parse({
      type: "fact",
      title: "x",
      scope: "global",
      status: "draft",
      sensitivity: "public",
      confidence: "low",
      sources: [{ resource: "inbox/a.yaml" }],
      custom_field: 1,
    });
    expect((parsed as Record<string, unknown>).custom_field).toBe(1);
  });

  test("rejects bad scope and missing sources", () => {
    const r = ConceptFrontmatter.safeParse({
      type: "fact",
      title: "x",
      scope: "everywhere",
      status: "draft",
      sensitivity: "public",
      confidence: "low",
      sources: [],
    });
    expect(r.success).toBe(false);
  });
});

describe("extraction schema", () => {
  test("parses a ChatGPT export and fills defaults", async () => {
    const data = Bun.YAML.parse(await fixture("extraction-chatgpt.yaml"));
    const exp = ExtractionExport.parse(data);
    expect(exp.export.tool).toBe("chatgpt");
    expect(exp.items).toHaveLength(2);
    expect(exp.items[1]?.saved_at).toBe("unknown");
    expect(exp.gaps).toHaveLength(1);
  });
});

describe("flag schema", () => {
  test("requires an authenticated reporter and a timestamp", () => {
    expect(
      Flag.safeParse({
        kind: "wrong",
        concept_id: "tools/bigquery",
        reported_by: "claude-code",
        what_happened: "Column renamed.",
        at: "2026-11-22T21:10:00Z",
      }).success,
    ).toBe(true);
    expect(
      Flag.safeParse({ kind: "wrong", what_happened: "x", at: "2026-11-22T21:10:00Z" }).success,
    ).toBe(false);
  });
});

describe("secrets", () => {
  test("finds tokens and card numbers, ignores normal text", () => {
    expect(findSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")).toContain(
      "github-token",
    );
    expect(findSecrets("card 4242 4242 4242 4242")).toContain("card-number");
    expect(findSecrets("Prefers short replies, ships on 2026-11-22.")).toEqual([]);
  });
});
