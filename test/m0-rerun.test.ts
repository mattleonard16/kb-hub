import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importRun } from "../src/commands/import.ts";
import { prepareCommitMsg } from "../src/hooks/commit.ts";
import { inferReads, inferWrites } from "../src/importers/shell.ts";
import { modelFromSessionFile, withSessionModel } from "../src/lib/harness-model.ts";
import { detectIdentity } from "../src/lib/identity.ts";
import { ctxFor, memLedger, tempDir, tempRepo } from "./helpers.ts";

describe("shell reads Codex actually uses", () => {
  test.each([
    [`printf '%s' "$(cat note.txt)" > hello.txt`, ["note.txt"], ["hello.txt"]],
    ["tr -d '\\n' < note.txt > hello.txt", ["note.txt"], ["hello.txt"]],
    ["word=`cat note.txt`; echo $word > hello.txt", ["note.txt"], ["hello.txt"]],
    ["bash -lc 'cat <<EOF > x.txt'", [], ["x.txt"]],
  ] as const)("%s", (cmd, reads, writes) => {
    expect(inferReads(cmd)).toEqual([...reads]);
    expect(inferWrites(cmd)).toEqual([...writes]);
  });
});

const codexRun = (repo: string) =>
  [
    { type: "thread.started", thread_id: "01a21b25-203d-7d63-958b-e2b1df89eb30" },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "bash -lc 'cat ~/.codex/skills/unslop/SKILL.md'",
      },
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "sed -n '1,40p' /Users/x/.codex/plugins/a/SKILL.md",
      },
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: `bash -lc "printf '%s' \\"$(cat ${repo}/note.txt)\\" > hello.txt"`,
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

describe("Codex import", () => {
  test("keeps the task's reads and drops the harness's own files", () => {
    const repo = tempRepo();
    const db = memLedger();
    const file = join(tempDir(), "codex.jsonl");
    writeFileSync(file, codexRun(repo));
    const out = importRun(ctxFor(repo, { CODEX_HOME: tempDir() }), db, "codex", file);
    expect(db.query("SELECT path, source FROM reads").all()).toEqual([
      { path: "note.txt", source: "inferred" },
    ]);
    expect(out.text).toContain("1 reads, 1 writes");
  });

  test("maps a path through a symlinked directory into the repo", () => {
    const repo = tempRepo();
    const link = join(tempDir(), "link");
    symlinkSync(repo, link);
    const db = memLedger();
    const file = join(tempDir(), "codex.jsonl");
    writeFileSync(file, codexRun(link));
    importRun(ctxFor(repo, { CODEX_HOME: tempDir() }), db, "codex", file);
    expect(db.query("SELECT path FROM reads").all()).toEqual([{ path: "note.txt" }]);
  });
});

describe("model from the harness's session file", () => {
  test("Claude Code transcript", () => {
    const home = tempDir();
    const dir = join(home, ".claude", "projects", "-work-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sess-1.jsonl"),
      '{"type":"assistant","message":{"model":"claude-opus-5-5"}}\n{"type":"assistant","message":{"model":"claude-fable-5-2"}}\n',
    );
    const id = detectIdentity({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-1" });
    expect(modelFromSessionFile(id, { HOME: home })).toBe("claude-fable-5-2");
    expect(withSessionModel(id, { HOME: home }).model).toBe("claude-fable-5-2");
  });

  test("Codex rollout file, keyed by CODEX_THREAD_ID", () => {
    const home = tempDir();
    const dir = join(home, ".codex", "sessions", "2026", "11", "27");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-2026-11-27T03-50-00-t-1.jsonl"),
      '{"payload":{"model":"gpt-6.2-astra"}}\n',
    );
    const id = detectIdentity({ CODEX_THREAD_ID: "t-1", CODEX_VERSION: "0.172.0" });
    expect(id.cli_version).toBe("0.172.0");
    expect(withSessionModel(id, { HOME: home }).model).toBe("gpt-6.2-astra");
  });

  test("no file, an unsafe id, or the person: unchanged", () => {
    const home = tempDir();
    const claude = detectIdentity({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "nope" });
    expect(withSessionModel(claude, { HOME: home }).model).toBe("unknown");
    const unsafe = detectIdentity({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "../../x" });
    expect(modelFromSessionFile(unsafe, { HOME: home })).toBeNull();
    const person = detectIdentity({});
    expect(withSessionModel(person, { HOME: home })).toEqual(person);
  });

  test("the commit trailer names the model", () => {
    const repo = tempRepo();
    const ctx = ctxFor(repo, { CODEX_THREAD_ID: "t-1" });
    ctx.identity = { ...ctx.identity, model: "gpt-6.2-astra" };
    const msg = join(tempDir(), "MSG");
    writeFileSync(msg, "add hello\n");
    prepareCommitMsg(ctx, msg);
    expect(Bun.file(msg).text()).resolves.toContain("Assisted-by: codex:gpt-6.2-astra");
  });
});

describe("codex identity", () => {
  test("CODEX_SANDBOX alone still marks an agent session", () => {
    expect(detectIdentity({ CODEX_SANDBOX: "seatbelt" })).toMatchObject({
      vendor: "codex",
      agent: true,
    });
  });
});
