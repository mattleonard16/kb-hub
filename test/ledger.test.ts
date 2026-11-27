import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../src/commands/init.ts";
import { parseCounts, runTest } from "../src/commands/test.ts";
import { installHooks } from "../src/hooks/install.ts";
import { ensureRun, openLedger } from "../src/ledger/db.ts";
import { detectIdentity } from "../src/lib/identity.ts";
import { CLAUDE_ENV, CLI, cleanEnv, ctxFor, memLedger, sh, tempDir, tempRepo } from "./helpers.ts";

describe("parseCounts", () => {
  test.each([
    ["bun", " 12 pass\n 2 fail\n", 1, { passed: 12, failed: 2 }],
    ["jest", "Tests:       1 failed, 9 passed, 10 total", 1, { passed: 9, failed: 1 }],
    ["vitest", " Tests  3 failed | 40 passed (43)", 1, { passed: 40, failed: 3 }],
    ["pytest", "==== 5 passed, 1 failed in 0.3s ====", 1, { passed: 5, failed: 1 }],
    ["cargo", "test result: ok. 7 passed; 0 failed;", 0, { passed: 7, failed: 0 }],
  ] as const)("%s summary", (_name, output, code, expected) => {
    expect(parseCounts(output, code)).toEqual(expected);
  });

  test("falls back to the exit code", () => {
    expect(parseCounts("ok", 0)).toEqual({ passed: 1, failed: 0 });
    expect(parseCounts("boom", 2)).toEqual({ passed: 0, failed: 1 });
  });

  test("a non-zero exit always counts at least one failure", () => {
    expect(parseCounts(" 4 pass\n 0 fail", 1)).toEqual({ passed: 4, failed: 1 });
  });
});

describe("baton test", () => {
  test("records pass/fail, commit, dirty state and the session", async () => {
    const repo = tempRepo();
    const db = memLedger();
    const ctx = ctxFor(repo, CLAUDE_ENV);
    const pass = await runTest(ctx, db, ["sh", "-c", "echo ' 3 pass'; echo ' 0 fail'"], true);
    expect(pass.code).toBe(0);
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const fail = await runTest(
      ctx,
      db,
      ["sh", "-c", "echo 'SECRET_KEY=hunter2'; echo ' 1 fail'; exit 1"],
      true,
    );
    expect(fail.code).toBe(1);
    const rows = db
      .query<
        { passed: number; failed: number; dirty: number; output_tail: string; vendor: string },
        []
      >(
        `SELECT passed, failed, dirty, output_tail, runs.vendor FROM test_results JOIN runs ON runs.id = run_id ORDER BY test_results.id`,
      )
      .all();
    expect(rows.map((r) => [r.passed, r.failed, r.dirty, r.vendor])).toEqual([
      [3, 0, 0, "claude-code"],
      [0, 1, 1, "claude-code"],
    ]);
    expect(rows[1]?.output_tail).not.toContain("hunter2");
  });
});

describe("git hooks", () => {
  test("an agent commit gets trailers and lands in the ledger under its session", () => {
    const repo = tempRepo();
    const home = tempDir();
    init(ctxFor(repo), { batonCmd: `'${process.execPath}' '${CLI}'` });
    writeFileSync(join(repo, "b.txt"), "two\n");
    const env = cleanEnv({ ...CLAUDE_ENV, BATON_HOME: home });
    sh(repo, ["git", "add", "b.txt"], env);
    sh(repo, ["git", "commit", "-qm", "add b"], env);
    const msg = sh(repo, ["git", "log", "-1", "--format=%B"], env);
    expect(msg).toContain("Assisted-by: claude-code:claude-opus-5-5");
    expect(msg).toContain("Baton-Session: claude-code/sess-claude-1");
    const db = openLedger(home);
    const row = db
      .query<{ files: number; vendor: string; session_id: string }, []>(
        "SELECT files, vendor, session_id FROM commits JOIN runs ON runs.id = run_id",
      )
      .get();
    expect(row).toEqual({ files: 1, vendor: "claude-code", session_id: "sess-claude-1" });
    expect(db.query("SELECT path, source FROM writes").all()).toEqual([
      { path: "b.txt", source: "git" },
    ]);
  });

  test("a commit by the person gets no trailers and no run", () => {
    const repo = tempRepo();
    const home = tempDir();
    init(ctxFor(repo), { batonCmd: `'${process.execPath}' '${CLI}'` });
    const env = cleanEnv({ BATON_HOME: home });
    writeFileSync(join(repo, "c.txt"), "three\n");
    sh(repo, ["git", "add", "c.txt"], env);
    sh(repo, ["git", "commit", "-qm", "add c"], env);
    expect(sh(repo, ["git", "log", "-1", "--format=%B"], env)).toBe("add c");
    const db = openLedger(home);
    expect(db.query("SELECT run_id FROM commits").all()).toEqual([{ run_id: null }]);
  });

  test("a hook Baton didn't write is left alone", () => {
    const repo = tempRepo();
    const path = join(repo, ".git", "hooks", "post-commit");
    writeFileSync(path, "#!/bin/sh\necho mine\n");
    const results = installHooks(repo, "baton");
    expect(results.find((r) => r.hook === "post-commit")?.status).toBe("skipped-foreign");
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(installHooks(repo, "baton").find((r) => r.hook === "prepare-commit-msg")?.status).toBe(
      "updated",
    );
  });

  test("a broken Baton never blocks a commit", () => {
    const repo = tempRepo();
    installHooks(repo, "/nonexistent/baton");
    writeFileSync(join(repo, "d.txt"), "four\n");
    const env = cleanEnv(CLAUDE_ENV);
    sh(repo, ["git", "add", "d.txt"], env);
    expect(() => sh(repo, ["git", "commit", "-qm", "add d"], env)).not.toThrow();
  });
});

describe("runs", () => {
  test("a known model is never overwritten by unknown", () => {
    const db = memLedger();
    const now = new Date();
    ensureRun(db, { ...detectIdentity(CLAUDE_ENV) }, "env", now);
    const after = ensureRun(db, { ...detectIdentity(CLAUDE_ENV), model: "unknown" }, "env", now);
    expect(after.model).toBe("claude-opus-5-5");
  });
});
