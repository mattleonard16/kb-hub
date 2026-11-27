import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importRun } from "../src/commands/import.ts";
import { parseClaude } from "../src/importers/claude.ts";
import { modelFromRollout, parseCodex } from "../src/importers/codex.ts";
import { ImportError } from "../src/importers/types.ts";
import { ctxFor, fixture, memLedger, tempDir, tempRepo } from "./helpers.ts";

const read = (name: string) => readFileSync(fixture(name), "utf8");

describe("claude importer", () => {
  test("reads model, tokens and turns from --output-format json", () => {
    const run = parseClaude(read("claude-result.json"));
    expect(run.vendor).toBe("claude-code");
    expect(run.session_id).toBe("2e28062e-ada8-4164-8722-954242e76b64");
    expect(run.model).toBe("claude-opus-5-5");
    expect(run.turns).toBe(1);
    expect(run.output_tokens).toBe(4);
    expect(run.cache_read_tokens).toBe(27268);
    expect(run.wall_ms).toBeGreaterThan(0);
    expect(run.tool_events).toBe(0);
  });

  test("reads tool events (read set) from stream-json", () => {
    const run = parseClaude(read("claude-stream.jsonl"));
    expect(run.model).toBe("claude-opus-5-5");
    expect(run.cli_version).toBe("2.1.332");
    expect(run.tool_events).toBe(1);
    expect(run.reads).toEqual(["/tmp/m0probe/note.txt"]);
    expect(run.writes).toEqual([]);
  });

  test("rejects output with no result event", () => {
    expect(() => parseClaude('{"type":"system"}')).toThrow(ImportError);
  });
});

describe("codex importer", () => {
  test("reads thread id, usage and file changes", () => {
    const run = parseCodex(read("codex-exec.synthetic.jsonl"), { codexHome: tempDir() });
    expect(run.session_id).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(run.turns).toBe(1);
    expect(run.input_tokens).toBe(24763);
    expect(run.cache_read_tokens).toBe(24448);
    expect(run.output_tokens).toBe(122);
    expect(run.writes).toEqual(["/work/repo/src/app.ts", "/work/repo/hello.txt"]);
    expect(run.tool_events).toBe(2);
    expect(run.model).toBeNull();
  });

  test("finds the model in the session rollout file when events lack it", () => {
    const home = tempDir();
    const dir = join(home, "sessions", "2026", "11", "27");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-2026-11-27T01-00-00-0199a213-81c0-7800-8aa1-bbab2a035a53.jsonl"),
      '{"type":"turn_context","payload":{"model":"gpt-5.5-codex"}}\n',
    );
    expect(modelFromRollout("0199a213-81c0-7800-8aa1-bbab2a035a53", home)).toBe("gpt-5.5-codex");
    expect(parseCodex(read("codex-exec.synthetic.jsonl"), { codexHome: home }).model).toBe(
      "gpt-5.5-codex",
    );
    expect(modelFromRollout("../../etc", home)).toBeNull();
  });

  test("rejects output that is not codex events", () => {
    expect(() => parseCodex('{"type":"result"}')).toThrow(ImportError);
  });
});

describe("baton import", () => {
  test("stores the run and its read set, keyed by session", () => {
    const repo = tempRepo();
    const db = memLedger();
    const ctx = ctxFor(repo);
    const out = importRun(ctx, db, "claude", fixture("claude-stream.jsonl"));
    expect(out.code).toBe(0);
    importRun(ctx, db, "claude", fixture("claude-stream.jsonl"));
    const runs = db.query("SELECT vendor, model, turns, identity_source FROM runs").all();
    expect(runs).toEqual([
      {
        vendor: "claude-code",
        model: "claude-opus-5-5",
        turns: 2,
        identity_source: "headless-json",
      },
    ]);
    expect(db.query("SELECT path, source FROM reads").all()).toEqual([
      { path: "/tmp/m0probe/note.txt", source: "json-events" },
    ]);
  });

  test("joins the run a git hook already created for the same session", () => {
    const repo = tempRepo();
    const db = memLedger();
    const session = "b954626f-a872-469c-bd48-5f65a749ea2b";
    const hookCtx = ctxFor(repo, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session });
    db.query(
      "INSERT INTO runs (vendor, session_id, identity_source, started) VALUES ('claude-code', ?, 'env', 'x')",
    ).run(session);
    importRun(hookCtx, db, "claude", fixture("claude-stream.jsonl"));
    expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
    expect(db.query("SELECT model FROM runs").get()).toEqual({ model: "claude-opus-5-5" });
  });
});
