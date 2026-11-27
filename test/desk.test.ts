import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { handoffCreate, lint } from "../src/commands/handoff.ts";
import { AGENT_SECTION, IGNORED, init, upsertSection } from "../src/commands/init.ts";
import { runTest } from "../src/commands/test.ts";
import { accept, prepareHandoff, prepareReview } from "../src/desk/actions.ts";
import { type Card, digest } from "../src/desk/digest.ts";
import { recordCommit } from "../src/hooks/commit.ts";
import { CLAUDE_ENV, CODEX_ENV, cleanEnv, ctxFor, memLedger, sh, tempRepo } from "./helpers.ts";

/** A repo where Claude Code made one commit and a test run failed on it. */
async function deskWithWork() {
  const repo = tempRepo();
  const db = memLedger();
  const agent = ctxFor(repo, CLAUDE_ENV);
  const person = ctxFor(repo);
  writeFileSync(join(repo, "b.txt"), "two\n");
  sh(repo, ["git", "add", "b.txt"]);
  sh(repo, ["git", "commit", "-qm", "add b"]);
  recordCommit(agent, db);
  const suite = [
    "sh",
    "-c",
    "if [ -f fail ]; then echo ' 1 pass'; echo ' 1 fail'; exit 1; fi; echo ' 2 pass'",
  ];
  await runTest(agent, db, suite, true);
  writeFileSync(join(repo, "fail"), "");
  await runTest(agent, db, suite, true);
  return { repo, db, agent, person };
}

const kinds = (cards: Card[]) => cards.map((c) => c.kind);

describe("digest", () => {
  test("failing tests first, then commits, then handoffs, each with next actions", async () => {
    const { db, agent, person } = await deskWithWork();
    handoffCreate(agent, db, {
      goal: "g",
      acceptance: ["a"],
      next: "n",
      observation: ["1 fail"],
    });
    const out = digest(person, db);
    const cards = (out.data as { cards: Card[] }).cards;
    expect(kinds(cards)).toEqual(["failing-test", "commit", "handoff"]);
    const failing = cards[0] as Extract<Card, { kind: "failing-test" }>;
    expect(failing.last_passing).toMatch(/^[0-9a-f]{40}$/);
    expect(failing.by).toBe("claude-code:claude-opus-5-5");
    const commit = cards[1] as Extract<Card, { kind: "commit" }>;
    expect(commit.tests).toBe("passed (2 passed, 0 failed)");
    expect(commit.actions[0]).toMatch(/^baton accept c-[0-9a-f]{7}$/);
    expect(out.text).toContain("✗ FAILING");
  });

  test("an empty desk says so", () => {
    const repo = tempRepo();
    expect(digest(ctxFor(repo), memLedger()).text).toContain("the desk is clear");
  });
});

describe("accept", () => {
  test("records the person's verdict and clears the card", async () => {
    const { db, person } = await deskWithWork();
    const cards = (digest(person, db).data as { cards: Card[] }).cards;
    const card = cards.find((c) => c.kind === "commit")?.card ?? "";
    expect(accept(person, db, card).code).toBe(0);
    expect(kinds((digest(person, db).data as { cards: Card[] }).cards)).not.toContain("commit");
    expect(db.query("SELECT target_kind, accepted FROM verdicts").get()).toEqual({
      target_kind: "commit",
      accepted: 1,
    });
  });

  test("is refused inside an agent session", async () => {
    const { db, agent, person } = await deskWithWork();
    const card =
      (digest(person, db).data as { cards: Card[] }).cards.find((c) => c.kind === "commit")?.card ??
      "";
    expect(accept(agent, db, card).code).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM verdicts").get()).toEqual({ n: 0 });
  });

  test("an unknown card is a validation failure", async () => {
    const { db, person } = await deskWithWork();
    expect(accept(person, db, "c-0000000").code).toBe(1);
    expect(accept(person, db, "h-9").code).toBe(1);
  });
});

describe("prepare", () => {
  test("handoff is pre-filled from the ledger and fails lint until TODOs are filled", async () => {
    const { repo, db, person } = await deskWithWork();
    const out = prepareHandoff(person, db, {});
    expect(out.code).toBe(0);
    expect(out.text).toContain("Read .baton/handoffs/h-1.md and continue.");
    const text = readFileSync(join(repo, ".baton/handoffs/h-1.md"), "utf8");
    expect(text).toContain("vendor: claude-code");
    expect(text).toContain("verify_cmd:");
    expect(text).toContain("1 passed, 1 failed");
    expect(lint(person, ["h-1"]).code).toBe(1);
  });

  test("review suggests a reviewer from the other vendor and states the evidence rule", async () => {
    const { repo, db, person } = await deskWithWork();
    const sha = sh(repo, ["git", "rev-parse", "HEAD"]);
    const out = prepareReview(person, db, sha.slice(0, 7));
    expect(out.code).toBe(0);
    expect(out.data).toMatchObject({ suggested_reviewer: "codex" });
    const text = readFileSync(join(repo, `.baton/reviews/r-${sha.slice(0, 7)}.md`), "utf8");
    expect(text).toContain("evidence_rule:");
    expect(text).toContain(`commit: ${sha}`);
  });

  test("prepare never starts a process other than git", async () => {
    const { db, person } = await deskWithWork();
    const spawned: string[] = [];
    const original = Bun.spawnSync;
    Bun.spawnSync = ((cmd: string[], opts: unknown) => {
      spawned.push(cmd[0] ?? "");
      return (original as (c: string[], o: unknown) => ReturnType<typeof Bun.spawnSync>)(cmd, opts);
    }) as typeof Bun.spawnSync;
    try {
      prepareHandoff(person, db, {});
    } finally {
      Bun.spawnSync = original;
    }
    expect(new Set(spawned)).toEqual(new Set(["git"]));
  });
});

describe("init", () => {
  test("gitignores packets, writes the agent section once, and leaves an @AGENTS.md import alone", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
    const ctx = ctxFor(repo);
    init(ctx, { hooks: false });
    init(ctx, { hooks: false });
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    for (const p of IGNORED) expect(gi.split("\n").filter((l) => l === p)).toHaveLength(1);
    const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(agents.split("<!-- baton:start -->")).toHaveLength(2);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(sh(repo, ["git", "check-ignore", ".baton/handoffs/h-1.md"])).toBe(
      ".baton/handoffs/h-1.md",
    );
  });

  test("upsertSection replaces an old section in place", () => {
    const old = "# Repo\n\n<!-- baton:start -->\nold\n<!-- baton:end -->\n\nmore\n";
    const out = upsertSection(old, AGENT_SECTION);
    expect(out.startsWith("# Repo\n\n<!-- baton:start -->")).toBe(true);
    expect(out.endsWith("<!-- baton:end -->\n\nmore\n")).toBe(true);
    expect(out).not.toContain("\nold\n");
  });
});

describe("cli", () => {
  test("unknown commands and unbuilt milestones are usage errors (exit 2)", async () => {
    const ctx = ctxFor(tempRepo());
    expect((await run(["nope"], ctx, memLedger())).code).toBe(2);
    expect((await run(["recommend", "bug-fix"], ctx, memLedger())).code).toBe(2);
    expect((await run(["handoff", "read", "bad-id"], ctx, memLedger())).code).toBe(2);
  });

  test("--json returns data, and repeatable fields work", async () => {
    const repo = tempRepo();
    const ctx = ctxFor(repo, CODEX_ENV);
    const out = await run(
      [
        "handoff",
        "create",
        "--json",
        "--goal",
        "g",
        "--acceptance",
        "a",
        "--acceptance",
        "b",
        "--next",
        "n",
        "--observation",
        "none ran",
      ],
      ctx,
      memLedger(),
    );
    expect(out.json).toBe(true);
    expect(out.data).toMatchObject({ ok: true, id: "h-1" });
  });

  test("baton test passes everything after -- to the command", async () => {
    const ctx = ctxFor(tempRepo(), {});
    const db = memLedger();
    const original = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const out = await run(["test", "--", "sh", "-c", "exit 3"], { ...ctx, env: cleanEnv() }, db);
      expect(out.code).toBe(1);
    } finally {
      process.stdout.write = original;
    }
    expect(db.query("SELECT exit_code FROM test_results").get()).toEqual({ exit_code: 3 });
  });
});
