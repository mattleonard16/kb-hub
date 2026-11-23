import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BEGIN,
  compileAll,
  END,
  pasteBlock,
  profileSection,
  upsertMarkedSection,
} from "../src/compile/compile.ts";
import {
  deliveryStatus,
  readState,
  recordDelivery,
  type SyncTarget,
  syncTargets,
} from "../src/compile/sync.ts";
import { loadKnowledge } from "../src/index/load.ts";
import { KnowledgeStore } from "../src/index/store.ts";
import { lintKnowledge } from "../src/lint/lint.ts";
import { fixtureDir, tempDir, tempKnowledge } from "./helpers.ts";

const ALL = ["public", "personal", "sensitive"] as const;

describe("index and search", () => {
  test("finds by title, body and tags; boosts verified", async () => {
    const store = new KnowledgeStore(await loadKnowledge(fixtureDir("knowledge-valid")));
    expect(store.size).toBe(5);
    const r = store.search("arr revenue", { allowed: [...ALL] });
    expect(r.results[0]?.id).toBe("data-access/bigquery");
    expect(r.results[0]?.verified).toBe(true);
  });

  test("filters by sensitivity, scope, type and hides deprecated", async () => {
    const store = new KnowledgeStore(await loadKnowledge(fixtureDir("knowledge-valid")));
    expect(store.search("peanut", { allowed: ["public", "personal"] }).total).toBe(0);
    expect(store.search("peanut", { allowed: [...ALL] }).total).toBe(1);
    expect(store.search("hub", { allowed: [...ALL], scope: "project:kb-hub" }).results[0]?.id).toBe(
      "projects/kb-hub",
    );
    expect(store.search("emoji", { allowed: [...ALL], type: "fact" }).total).toBe(0);
    expect(store.get("health/allergy", ["public", "personal"])).toBeNull();
  });

  test("paginates with a cursor and handles empty queries", async () => {
    const store = new KnowledgeStore(await loadKnowledge(fixtureDir("knowledge-valid")));
    const p1 = store.search("a e i o u replies emoji revenue hub", { allowed: [...ALL] }, 2);
    expect(p1.results).toHaveLength(2);
    expect(p1.next_cursor).toBe("2");
    const p2 = store.search(
      "a e i o u replies emoji revenue hub",
      { allowed: [...ALL] },
      2,
      p1.next_cursor,
    );
    expect(p2.results[0]?.id).not.toBe(p1.results[0]?.id);
    expect(store.search("  !!! ", { allowed: [...ALL] }).total).toBe(0);
  });
});

describe("compile", () => {
  test("profile has only verified, stable, global, non-sensitive concepts", async () => {
    const k = await loadKnowledge(fixtureDir("knowledge-valid"));
    const p = profileSection(k, 150);
    expect(p.conceptIds.sort()).toEqual([
      "data-access/bigquery",
      "profile/no-emoji",
      "profile/reply-length",
    ]);
    expect(p.text).not.toContain("Peanut");
    expect(p.text).not.toContain("kb-hub knowledge hub");
    expect(p.text).toContain("weekly-report");
    expect(p.text.indexOf("How to work with me")).toBeLessThan(p.text.indexOf("Preferences"));
  });

  test("respects line and character budgets", async () => {
    const k = await loadKnowledge(fixtureDir("knowledge-valid"));
    const tight = profileSection(k, 12);
    expect(tight.text.split("\n").length).toBeLessThanOrEqual(13);
    expect(tight.omitted.length).toBeGreaterThan(0);
    const paste = pasteBlock(k, 150);
    expect(paste.text.length).toBeLessThanOrEqual(150);
  });

  test("marked section replaces only its own block", () => {
    const mine = "# My notes\n\nKeep this line.\n";
    const once = upsertMarkedSection(mine, "v1");
    expect(once).toContain("Keep this line.");
    const twice = upsertMarkedSection(`${once}\nAfter.\n`, "v2");
    expect(twice).toContain("v2");
    expect(twice).not.toContain("v1");
    expect(twice).toContain("After.");
    expect(twice.split(BEGIN).length).toBe(2);
    expect(twice.split(END).length).toBe(2);
  });

  test("compileAll writes build/ that passes lint size caps", async () => {
    const root = await tempKnowledge();
    const m = await compileAll(root, await loadKnowledge(root));
    expect(Object.keys(m.outputs)).toContain("paste:chatgpt");
    expect(await readFile(join(root, "build/claude.md"), "utf8")).toContain(
      "Prefers short replies",
    );
    expect((await lintKnowledge(root)).ok).toBe(true);
  });
});

describe("sync and status", () => {
  async function targets(): Promise<SyncTarget[]> {
    const home = await tempDir();
    return [
      {
        name: "claude-code",
        instructions: join(home, ".claude/CLAUDE.md"),
        skillsDir: join(home, ".claude/skills"),
        lines: 150,
      },
      {
        name: "codex",
        instructions: join(home, ".codex/AGENTS.md"),
        skillsDir: join(home, ".codex/skills"),
        lines: 150,
      },
    ];
  }

  test("keeps hand-written lines, copies skills, never overwrites unmanaged skills", async () => {
    const k = await loadKnowledge(fixtureDir("knowledge-valid"));
    const [claude, codex] = await targets();
    if (!claude || !codex) throw new Error("targets");
    await mkdir(join(claude.instructions, ".."), { recursive: true });
    await writeFile(claude.instructions, "# Mine\n\nDo not touch.\n");
    await mkdir(join(codex.skillsDir, "weekly-report"), { recursive: true });
    await writeFile(join(codex.skillsDir, "weekly-report/SKILL.md"), "hand-made");

    const [rc, rx] = await syncTargets(k, [claude, codex]);
    const text = await readFile(claude.instructions, "utf8");
    expect(text.startsWith("# Mine\n\nDo not touch.")).toBe(true);
    expect(text).toContain(BEGIN);
    expect(rc?.skillsCopied).toEqual(["weekly-report"]);
    expect(rx?.skillsSkipped[0]).toContain("weekly-report");
    expect(await readFile(join(codex.skillsDir, "weekly-report/SKILL.md"), "utf8")).toBe(
      "hand-made",
    );

    await syncTargets(k, [claude, codex]);
    expect((await readFile(claude.instructions, "utf8")).split(BEGIN).length).toBe(2);
  });

  test("dry run writes nothing", async () => {
    const k = await loadKnowledge(fixtureDir("knowledge-valid"));
    const [claude] = await targets();
    if (!claude) throw new Error("targets");
    await syncTargets(k, [claude], { dryRun: true });
    expect(await Bun.file(claude.instructions).exists()).toBe(false);
  });

  test("status counts changes since last delivery", async () => {
    const root = await tempKnowledge();
    const statePath = join(await tempDir(), "state.json");
    let k = await loadKnowledge(root);
    expect(
      deliveryStatus(k, await readState(statePath)).find((t) => t.tool === "gemini")
        ?.changes_behind,
    ).toBe(3);
    await recordDelivery("gemini", k, statePath);
    expect(
      deliveryStatus(k, await readState(statePath)).find((t) => t.tool === "gemini")
        ?.changes_behind,
    ).toBe(0);
    const file = join(root, "knowledge/profile/reply-length.md");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("under 150 words", "under 100 words"),
    );
    k = await loadKnowledge(root);
    expect(
      deliveryStatus(k, await readState(statePath)).find((t) => t.tool === "gemini")
        ?.changes_behind,
    ).toBe(1);
  });
});
