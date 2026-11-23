import { describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { parseRepoArgs, repoStale } from "../src/curator/repo-stale.ts";
import { loadKnowledge } from "../src/index/load.ts";
import { KnowledgeStore } from "../src/index/store.ts";
import { cleanRemote, renderScan, scanRepo } from "../src/ingest/scan.ts";
import { lintKnowledge } from "../src/lint/lint.ts";
import { fixtureDir, quiet, tempDir } from "./helpers.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

/** The sample repo as a git checkout with one commit, AGENTS.md symlinked to CLAUDE.md. */
async function sampleRepo(): Promise<string> {
  const dir = join(await tempDir(), "sample");
  await cp(fixtureDir("repo-sample"), dir, { recursive: true });
  await symlink("CLAUDE.md", join(dir, "AGENTS.md"));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist/bundle.js"), "ignored\n");
  git(dir, "init", "-q", "-b", "main");
  git(
    dir,
    "remote",
    "add",
    "origin",
    "https://x-access-token:ghp_notreal@github.com/acme/sample.git",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("kb scan", () => {
  test("maps packages, folders, agent docs and the docs catalog at a commit", async () => {
    const dir = await sampleRepo();
    const scan = await scanRepo(dir, { name: "sample", exclude: ["docs/customers"] });
    expect(scan.commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(scan.branch).toBe("main");
    expect(scan.remote).toBe("github.com/acme/sample");
    expect(scan.packages.map((p) => [p.path, p.name])).toEqual([
      [".", "sample-mono"],
      ["apps/web", "@sample/web"],
      ["packages/core", "@sample/core"],
    ]);
    expect(scan.folders.map((f) => f.path)).toContain("apps/web/src/lib");
    expect(scan.folders.some((f) => f.path.startsWith("dist"))).toBe(false);

    const root = scan.instructions.find((i) => i.path === "CLAUDE.md");
    expect(root?.text).toContain("Bun workspaces");
    expect(scan.instructions.find((i) => i.path === "AGENTS.md")?.sameAs).toBe("CLAUDE.md");
    expect(scan.instructions.find((i) => i.path === "apps/web/CLAUDE.md")?.text).toBeUndefined();

    const docs = new Map(scan.docs.map((d) => [d.path, d]));
    expect(docs.get("docs/agent/ai-codemap.md")).toMatchObject({
      type: "codemap",
      title: "AI assistant codemap",
    });
    expect(docs.get("docs/adr/0001-default-model.md")?.title).toBe(
      "0001. Default model for the assistant",
    );
    expect(docs.get("docs/solutions/runtime-errors/stream-hang.md")?.type).toBe("runtime_error");
    expect([...docs.keys()].some((p) => p.startsWith("docs/customers"))).toBe(false);

    const text = renderScan(scan);
    expect(text).toContain(`commit: ${scan.commit}`);
    expect(text).not.toContain("ghp_notreal");
    expect(text).not.toContain("Customer setup");
    // The root instructions keep their own code fence intact.
    expect(text).toContain("````markdown\n# Sample monorepo");
  });

  test("works on a folder that is not a git checkout", async () => {
    const dir = join(await tempDir(), "plain");
    await cp(fixtureDir("repo-sample"), dir, { recursive: true });
    await mkdir(join(dir, "node_modules/x"), { recursive: true });
    await writeFile(join(dir, "node_modules/x/README.md"), "# x\n");
    const scan = await scanRepo(dir, { name: "plain" });
    expect(scan.commit).toBeNull();
    expect(scan.docs.some((d) => d.path.includes("node_modules"))).toBe(false);
    expect(scan.docs.some((d) => d.path.startsWith("docs/customers"))).toBe(true);
  });

  test("cleanRemote drops credentials", () => {
    expect(cleanRemote("https://user:tok@github.com/o/r.git")).toBe("github.com/o/r");
    expect(cleanRemote("git@github.com:o/r.git")).toBe("github.com/o/r");
  });

  test("the CLI queues it once per commit as a repo source", async () => {
    const dir = await sampleRepo();
    const root = join(await tempDir(), "knowledge");
    expect(await quiet(() => main(["init", root]))).toBe(0);
    const run = () =>
      quiet(() => main(["scan", dir, "--dir", root, "--exclude", "docs/customers"]));
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    const inbox = Bun.spawnSync(["ls", join(root, "inbox/sources")])
      .stdout.toString()
      .trim();
    const files = inbox.split("\n").filter((f) => f.includes("-repo-"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("sample-repo-scan");
    expect(quiet(() => main(["scan", dir, "--dir", root, "--depth", "0"]))).rejects.toThrow(
      "--depth takes a whole number",
    );
  });
});

const page = (lines: string[]) => `${lines.join("\n")}\n`;
const codePage = (extra: string[]) =>
  page([
    "---",
    "type: module",
    "title: AI client",
    "description: The assistant's model client",
    "scope: project:sample",
    "status: draft",
    "sensitivity: personal",
    "confidence: high",
    "sources:",
    "  - resource: raw/sources/scan.md",
    ...extra,
    "---",
    "Picks the default model. Part of [[repos/sample]].",
  ]);

describe("pages about code", () => {
  test("kb stale --repo flags a page once its path changes or disappears", async () => {
    const dir = await sampleRepo();
    const first = git(dir, "rev-parse", "HEAD");
    const pages = (resource: string, commit = first) => [
      {
        id: "modules/sample-ai",
        meta: { title: "AI client", status: "draft", repo: "sample", resource, commit },
      },
    ];
    const repos = parseRepoArgs([`sample=${dir}`]);
    expect(repoStale(pages("apps/web/src/lib/ai"), repos)).toEqual([]);

    await writeFile(join(dir, "packages/core/src/index.ts"), "export const x = 1;\n");
    git(dir, "commit", "-qam", "unrelated");
    expect(repoStale(pages("apps/web/src/lib/ai"), repos)).toEqual([]);

    await writeFile(join(dir, "apps/web/src/lib/ai/client.ts"), 'export const M = "big";\n');
    git(dir, "commit", "-qam", "change the client");
    expect(repoStale(pages("apps/web/src/lib/ai"), repos)[0]?.reason).toBe(
      `apps/web/src/lib/ai changed since ${first.slice(0, 7)}`,
    );
    expect(repoStale(pages("apps/web/src/lib/ai", "abcdef1"), repos)[0]?.reason).toContain(
      "not in this checkout",
    );
    await rm(join(dir, "apps/web/src/lib/ai"), { recursive: true });
    expect(repoStale(pages("apps/web/src/lib/ai"), repos)[0]?.reason).toBe(
      "apps/web/src/lib/ai no longer exists",
    );
    expect(repoStale(pages("x"), new Map())).toEqual([]);
    expect(() => parseRepoArgs(["sample"])).toThrow("<name>=<dir>");
  });

  test("lint checks repo fields; search finds lessons by symptom and code by path", async () => {
    const root = join(await tempDir(), "knowledge");
    expect(await quiet(() => main(["init", root]))).toBe(0);
    await mkdir(join(root, "raw/sources"), { recursive: true });
    await writeFile(join(root, "raw/sources/scan.md"), "# Repo scan: sample\n");
    await mkdir(join(root, "wiki/modules"), { recursive: true });
    await mkdir(join(root, "wiki/repos"), { recursive: true });
    await mkdir(join(root, "wiki/lessons"), { recursive: true });
    await writeFile(
      join(root, "wiki/repos/sample.md"),
      page([
        "---",
        "type: repo",
        "title: sample",
        "scope: project:sample",
        "status: draft",
        "sensitivity: personal",
        "confidence: high",
        "repo: sample",
        "resource: .",
        "sources:",
        "  - resource: raw/sources/scan.md",
        "---",
        "A Bun monorepo. Modules: [[modules/sample-ai]]. Lessons: [[lessons/stream-hang]].",
      ]),
    );
    await writeFile(join(root, "wiki/modules/sample-ai.md"), codePage(["repo: sample"]));
    await writeFile(
      join(root, "wiki/lessons/stream-hang.md"),
      page([
        "---",
        "type: lesson",
        "title: Stream stays open after the done event",
        "scope: project:sample",
        "status: draft",
        "sensitivity: personal",
        "confidence: high",
        "applies_when:",
        "  - A streaming route does background work after the answer",
        "symptoms:",
        "  - The client sees the answer but the request never closes",
        "sources:",
        "  - resource: raw/sources/scan.md",
        "---",
        "Move background work into after(). Seen in [[repos/sample]].",
      ]),
    );
    const missing = (await lintKnowledge(root)).issues.filter((i) => i.rule === "repo-fields");
    expect(missing.map((i) => i.message)).toEqual([
      "a module page needs resource: <path in the repo>",
    ]);

    await writeFile(
      join(root, "wiki/modules/sample-ai.md"),
      codePage(["repo: sample", "resource: ../outside", "commit: 0123abc"]),
    );
    expect(
      (await lintKnowledge(root)).issues
        .filter((i) => i.rule === "repo-fields")
        .map((i) => i.message),
    ).toEqual(['with repo set, resource is a path inside the repo, got "../outside"']);

    await writeFile(
      join(root, "wiki/modules/sample-ai.md"),
      codePage(["repo: sample", "resource: apps/web/src/lib/ai", "commit: 0123abc"]),
    );
    expect(await quiet(() => main(["index", "--dir", root]))).toBe(0);
    const lint = await lintKnowledge(root);
    expect(lint.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(await readFile(join(root, "wiki/index.md"), "utf8")).toContain("## Lessons");

    const store = new KnowledgeStore(await loadKnowledge(root));
    const all = { allowed: ["public", "personal", "sensitive"] as const };
    expect(store.search("request never closes", { allowed: [...all.allowed] }).results[0]?.id).toBe(
      "lessons/stream-hang",
    );
    expect(
      store.search("lib ai", { allowed: [...all.allowed], type: "module" }).results[0]?.id,
    ).toBe("modules/sample-ai");
  });
});
