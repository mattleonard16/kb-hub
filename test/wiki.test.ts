import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileAll } from "../src/compile/compile.ts";
import { renderIndex } from "../src/compile/wiki-index.ts";
import { loadKnowledge } from "../src/index/load.ts";
import { KnowledgeStore } from "../src/index/store.ts";
import { quoteHint } from "../src/lib/frontmatter.ts";
import { linkGraph, linkTargets } from "../src/lib/links.ts";
import { lintKnowledge } from "../src/lint/lint.ts";
import { fixtureDir, tempKnowledge } from "./helpers.ts";

describe("wiki links", () => {
  test("reads wikilinks with labels and headings, and Markdown links to pages", () => {
    expect(
      linkTargets(
        "See [[projects/kb-hub]], [[kb-hub|the hub]], [[topics/llm-wiki#Layers]] and [x](/wiki/people/sam.md).",
      ),
    ).toEqual(["projects/kb-hub", "kb-hub", "topics/llm-wiki", "people/sam"]);
  });

  test("resolves by id or a unique file name, and reports broken or ambiguous links", () => {
    const g = linkGraph([
      { id: "projects/kb-hub", body: "[[llm-wiki]] [[missing]] [[notes]]" },
      { id: "topics/llm-wiki", body: "[[projects/kb-hub]]" },
      { id: "a/notes", body: "" },
      { id: "b/notes", body: "" },
    ]);
    expect(g.links.get("projects/kb-hub")).toEqual(["topics/llm-wiki"]);
    expect(g.backlinks.get("projects/kb-hub")).toEqual(["topics/llm-wiki"]);
    expect(g.broken.get("projects/kb-hub")).toEqual(["missing", "notes"]);
  });

  test("backlinks hide pages the caller may not see", async () => {
    const root = await tempKnowledge();
    const file = join(root, "wiki/health/allergy.md");
    await writeFile(file, `${await readFile(file, "utf8")}\nRelated: [[projects/kb-hub]].\n`);
    const store = new KnowledgeStore(await loadKnowledge(root));
    expect(store.related("projects/kb-hub", ["public", "personal", "sensitive"]).backlinks).toEqual(
      ["health/allergy", "sources/2026-11-22-kb-hub-planning", "topics/llm-wiki"],
    );
    expect(store.related("projects/kb-hub", ["public", "personal"]).backlinks).toEqual([
      "sources/2026-11-22-kb-hub-planning",
      "topics/llm-wiki",
    ]);
  });
});

describe("index.md and lint", () => {
  test("index lists every page by folder with a link and summary", async () => {
    const text = renderIndex(await loadKnowledge(fixtureDir("knowledge-valid")));
    expect(text).toContain("## Sources (1)");
    expect(text).toContain(
      "- [[topics/llm-wiki|LLM Wiki]]: Karpathy's pattern of raw sources, an agent-maintained wiki, and a schema file. _(draft)_",
    );
    expect(text.indexOf("## Profile")).toBeLessThan(text.indexOf("## Sources"));
  });

  test("lint flags orphans, source pages without raw files, missing sources and a stale index", async () => {
    const root = await tempKnowledge();
    await writeFile(
      join(root, "wiki/topics/lonely.md"),
      [
        "---",
        "type: source",
        "title: Lonely source",
        "scope: global",
        "status: draft",
        "sensitivity: public",
        "confidence: low",
        "sources:",
        "  - resource: inbox/sources/gone.md",
        "---",
        "Nobody links here.",
        "",
      ].join("\n"),
    );
    const r = await lintKnowledge(root);
    const rules = r.issues.filter((i) => i.file === "wiki/topics/lonely.md").map((i) => i.rule);
    expect(rules.sort()).toEqual(["missing-source", "orphan", "source-raw"]);
    expect(r.issues.some((i) => i.rule === "index-stale")).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("a YAML error says which value to quote, and links to that page say why they break", async () => {
    expect(quoteHint("title: Web app\ndescription: @acme/web: the app")).toContain('"description"');
    expect(quoteHint('description: "@acme/web: the app"\nscope: global')).toBeNull();
    const root = await tempKnowledge();
    const llm = join(root, "wiki/topics/llm-wiki.md");
    const text = await readFile(llm, "utf8");
    await writeFile(llm, text.replace(/^title: .*$/m, "title: LLM Wiki: the layout"));
    const r = await lintKnowledge(root);
    const own = r.issues.find((i) => i.file === "wiki/topics/llm-wiki.md");
    expect(own?.message).toContain('Put the value of "title" in double quotes');
    const link = r.issues.find((i) => i.rule === "broken-link" && i.message.includes("llm-wiki"));
    expect(link?.message).toContain("frontmatter is invalid");
  });

  test("search ranks pages that match more of the question, and code pages by path", async () => {
    const root = await tempKnowledge();
    const page = (type: string, title: string, body: string, extra: string[] = []) =>
      [
        "---",
        `type: ${type}`,
        `title: ${title}`,
        "scope: project:app",
        "status: draft",
        "sensitivity: personal",
        "confidence: high",
        ...extra,
        "sources:",
        "  - resource: raw/2026-11-22-planning-call.md",
        "---",
        body,
        "",
      ].join("\n");
    await writeFile(
      join(root, "wiki/topics/assistant-names.md"),
      page("concept", "Assistant assistant assistant", "Assistant names, assistant list."),
    );
    await writeFile(
      join(root, "wiki/topics/app-assistant.md"),
      page("feature", "App assistant", "The assistant code lives in the chat route.", [
        "repo: app",
        "resource: src/app/api/chat",
      ]),
    );
    await writeFile(
      join(root, "wiki/topics/app-web.md"),
      page("module", "App web", "The web app: src, app, api, chat and more.", [
        "repo: app",
        "resource: src",
      ]),
    );
    await writeFile(
      join(root, "wiki/topics/stream-lesson.md"),
      page("lesson", "Streams", "Finish before close.", [
        "symptoms: The request never closes after the answer",
      ]),
    );
    const store = new KnowledgeStore(await loadKnowledge(root));
    const all = {
      allowed: ["public", "personal", "sensitive"] as Array<"public" | "personal" | "sensitive">,
    };
    expect(store.search("where does the assistant code live", all).results[0]?.id).toBe(
      "topics/app-assistant",
    );
    expect(store.search("src/app/api/chat/handler.ts", all).results[0]?.id).toBe(
      "topics/app-assistant",
    );
    expect(store.search("src/lib", all).results[0]?.id).toBe("topics/app-web");
    // One symptom written as a string, the way many solutions docs do.
    expect(store.search("request never closes", all).results[0]?.id).toBe("topics/stream-lesson");
  });

  test("source, concept and synthesis pages never become always-on", async () => {
    const root = await tempKnowledge();
    const file = join(root, "wiki/topics/llm-wiki.md");
    await writeFile(
      file,
      (await readFile(file, "utf8"))
        .replace("status: draft", "status: stable")
        .replace("---\nThree", 'verified: [{ by: "human:matt", at: 2026-11-23 }]\n---\nThree'),
    );
    const m = await compileAll(root, await loadKnowledge(root));
    expect(m.outputs.claude?.concepts).not.toContain("topics/llm-wiki");
  });
});
