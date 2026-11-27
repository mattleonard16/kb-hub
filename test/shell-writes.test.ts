import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { importRun } from "../src/commands/import.ts";
import { parseClaude } from "../src/importers/claude.ts";
import { inferWrites } from "../src/importers/shell.ts";
import { ctxFor, memLedger, tempDir, tempRepo } from "./helpers.ts";

describe("inferWrites", () => {
  test.each([
    ["printf 'baton\\n' > hello.txt", ["hello.txt"]],
    ["echo hi >> log.txt 2>/dev/null", ["log.txt"]],
    ['bash -lc "echo x >out.txt && cp a.txt b.txt"', ["out.txt", "b.txt"]],
    ["cat <<EOF > notes.md", ["notes.md"]],
    ["sort data | tee sorted.txt", ["sorted.txt"]],
    ["sed -i 's/a/b/' src/x.ts", ["src/x.ts"]],
    ["touch a b", ["a", "b"]],
    ["npm test 2>&1", []],
    ["git commit -m 'a > b'", []],
  ] as const)("%s", (cmd, expected) => {
    expect(inferWrites(cmd)).toEqual([...expected]);
  });
});

/** The shape of Matt's M0 run: Claude wrote the file with Bash printf, not the Write tool. */
const BASH_WRITE = [
  { type: "system", subtype: "init", session_id: "s-bash", model: "claude-opus-5-5" },
  {
    type: "assistant",
    session_id: "s-bash",
    message: {
      model: "claude-opus-5-5",
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/note.txt" } },
        {
          type: "tool_use",
          id: "t2",
          name: "Bash",
          input: {
            command: "printf 'baton' > hello.txt && git add hello.txt && git commit -m 'add hello'",
          },
        },
      ],
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "s-bash",
    num_turns: 3,
    usage: { input_tokens: 5, output_tokens: 50 },
    modelUsage: { "claude-opus-5-5": { outputTokens: 50 } },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("Claude Code writes through Bash", () => {
  test("are inferred from the command", () => {
    const run = parseClaude(BASH_WRITE);
    expect(run.writes).toEqual([]);
    expect(run.inferred_writes).toEqual(["hello.txt"]);
    expect(run.reads).toEqual(["/r/note.txt"]);
  });

  test("are stored as inferred writes", () => {
    const repo = tempRepo();
    const db = memLedger();
    const file = join(tempDir(), "run.jsonl");
    writeFileSync(file, BASH_WRITE);
    importRun(ctxFor(repo), db, "claude", file);
    expect(db.query("SELECT path, source FROM writes").all()).toEqual([
      { path: "hello.txt", source: "inferred" },
    ]);
  });
});
