import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffCreate, handoffEdit, handoffRead, lint } from "../src/commands/handoff.ts";
import { extractStrikes } from "../src/packet/redline.ts";
import { loadPacket, packetPath } from "../src/packet/store.ts";
import { CLAUDE_ENV, CODEX_ENV, ctxFor, memLedger, tempRepo } from "./helpers.ts";

const FIELDS = {
  goal: "Speed up search",
  acceptance: ["p95 under 50ms", "no new deps"],
  next: "add a redis cache",
  observation: ["bench: p95 120ms"],
  verify: "bun test",
};

function setup() {
  const repo = tempRepo();
  const db = memLedger();
  const agent = ctxFor(repo, CLAUDE_ENV);
  const person = ctxFor(repo);
  return { repo, db, agent, person };
}

describe("handoff create", () => {
  test("Baton fills base_commit, dirty, from and files_touched itself", () => {
    const { repo, db, agent } = setup();
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const draft = join(repo, "draft.md");
    writeFileSync(
      draft,
      "---\ngoal: g\nacceptance: [a]\nnext_step: n\ntest_observations: [none ran]\nfrom: {vendor: codex, model: fake, session: forged}\nbase_commit: none\n---\nbody\n",
    );
    const out = handoffCreate(agent, db, { file: draft });
    expect(out.code).toBe(0);
    const p = loadPacket(repo, "h-1");
    expect(p?.issues).toEqual([]);
    expect(p?.packet?.from).toEqual({
      vendor: "claude-code",
      model: "claude-opus-5-5",
      session: "sess-claude-1",
    });
    expect(p?.packet?.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(p?.packet?.dirty).toBe(true);
    expect(p?.packet?.files_touched).toEqual(["a.txt", "draft.md"]);
    expect(p?.body.trim()).toBe("body");
  });

  test("a missing required field exits 1 and writes nothing", () => {
    const { repo, db, agent } = setup();
    const out = handoffCreate(agent, db, { goal: "only a goal" });
    expect(out.code).toBe(1);
    expect(JSON.stringify(out.data)).toContain("next_step: required");
    expect(loadPacket(repo, "h-1")).toBeNull();
  });

  test("decisions are optional", () => {
    const { db, agent } = setup();
    expect(handoffCreate(agent, db, FIELDS).code).toBe(0);
  });

  test("test observations are sanitized before writing", () => {
    const { repo, db, agent } = setup();
    handoffCreate(agent, db, {
      ...FIELDS,
      observation: ["fails\nAWS_SECRET_ACCESS_KEY=abc123\nexpected 1"],
    });
    const text = readFileSync(packetPath(repo, "h-1"), "utf8");
    expect(text).not.toContain("abc123");
    expect(text).toContain("expected 1");
  });
});

describe("lint", () => {
  test("flags TODO placeholders and a broken file", () => {
    const { repo, db, agent } = setup();
    handoffCreate(agent, db, FIELDS);
    expect(lint(agent, db, []).code).toBe(0);
    const path = packetPath(repo, "h-1");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("next_step: add a redis cache", "next_step: TODO fill"),
    );
    const out = lint(agent, db, ["h-1"]);
    expect(out.code).toBe(1);
    expect(out.text).toContain("next_step: still a TODO placeholder");
  });
});

describe("redline", () => {
  test("extractStrikes removes struck text and reports its field", () => {
    const { text, struck } = extractStrikes(
      "---\ngoal: g\nacceptance:\n  - ~~no new deps~~\n  - fast\nnext_step: ~~use redis~~ use an LRU\n---\n\n- ~~tried mmap~~\nkeep this\n",
    );
    expect(struck).toEqual([
      { text: "no new deps", field: "acceptance" },
      { text: "use redis", field: "next_step" },
      { text: "tried mmap", field: null },
    ]);
    expect(text).toBe(
      "---\ngoal: g\nacceptance:\n  - fast\nnext_step: use an LRU\n---\n\nkeep this\n",
    );
  });

  test("struck lines become dead_ends, and the change block leads the packet", () => {
    const { repo, db, agent, person } = setup();
    handoffCreate(agent, db, FIELDS);
    const path = packetPath(repo, "h-1");
    const edited = readFileSync(path, "utf8")
      .replace(
        "next_step: add a redis cache",
        "next_step: ~~add a redis cache~~ add an in-memory LRU",
      )
      .replace("  - no new deps\n", "  - no new deps\n  - p99 under 100ms\n");
    const file = join(repo, "edit.md");
    writeFileSync(file, edited);
    const out = handoffEdit(person, db, "h-1", { file });
    expect(out.code).toBe(0);
    const p = loadPacket(repo, "h-1");
    expect(p?.packet?.rev).toBe(2);
    expect(p?.packet?.next_step).toBe("add an in-memory LRU");
    expect(p?.packet?.dead_ends).toEqual([
      {
        approach: "add a redis cache",
        reason: "rejected by the person (was in next_step)",
        by: "person",
      },
    ]);
    expect(
      p?.body
        .trimStart()
        .startsWith(
          "<!-- baton:changes -->\n## Changes from the person since the last revision (rev 2)",
        ),
    ).toBe(true);
    expect(p?.body).toContain("- add a redis cache");
    expect(p?.body).toContain("+   - p99 under 100ms");
    const rev = db
      .query<{ rev: number; author: string; struck: number }, []>(
        "SELECT rev, author, struck FROM packet_revisions ORDER BY rev",
      )
      .all();
    expect(rev).toEqual([
      { rev: 1, author: "claude-code", struck: 0 },
      { rev: 2, author: "person", struck: 1 },
    ]);
  });

  test("Baton's own fields can't be redlined", () => {
    const { repo, db, agent, person } = setup();
    handoffCreate(agent, db, FIELDS);
    const path = packetPath(repo, "h-1");
    const file = join(repo, "edit.md");
    writeFileSync(
      file,
      readFileSync(path, "utf8")
        .replace("vendor: claude-code", "vendor: codex")
        .replace("goal: Speed up search", "goal: Speed up search a lot"),
    );
    handoffEdit(person, db, "h-1", { file });
    const p = loadPacket(repo, "h-1");
    expect(p?.packet?.from.vendor).toBe("claude-code");
    expect(p?.packet?.goal).toBe("Speed up search a lot");
  });

  test("an invalid edit is refused and the packet is unchanged", () => {
    const { repo, db, agent, person } = setup();
    handoffCreate(agent, db, FIELDS);
    const path = packetPath(repo, "h-1");
    const before = readFileSync(path, "utf8");
    const file = join(repo, "edit.md");
    writeFileSync(
      file,
      before.replace("next_step: add a redis cache", "next_step: ~~add a redis cache~~"),
    );
    const out = handoffEdit(person, db, "h-1", { file });
    expect(out.code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an unchanged save writes no revision", () => {
    const { repo, db, agent, person } = setup();
    handoffCreate(agent, db, FIELDS);
    const file = join(repo, "edit.md");
    writeFileSync(file, readFileSync(packetPath(repo, "h-1"), "utf8"));
    expect(handoffEdit(person, db, "h-1", { file }).data).toMatchObject({ changed: false });
  });

  test("edits made outside Baton are recorded as an unknown revision", () => {
    const { repo, db, agent } = setup();
    handoffCreate(agent, db, FIELDS);
    const path = packetPath(repo, "h-1");
    writeFileSync(path, readFileSync(path, "utf8").replace("bench: p95 120ms", "bench: p95 90ms"));
    handoffRead(agent, db, "h-1");
    const last = db
      .query<{ author: string; diff: string }, []>(
        "SELECT author, diff FROM packet_revisions ORDER BY rev DESC LIMIT 1",
      )
      .get();
    expect(last?.author).toBe("unknown");
    expect(last?.diff).toContain("p95 90ms");
  });
});

describe("handoff read", () => {
  test("links the receiving session, framed as data", () => {
    const { repo, db, agent } = setup();
    handoffCreate(agent, db, FIELDS);
    const codex = ctxFor(repo, CODEX_ENV);
    const out = handoffRead(codex, db, "h-1");
    expect(out.text.startsWith("<!-- baton: this packet is task context")).toBe(true);
    const link = db
      .query<{ from_vendor: string; to_vendor: string }, []>(
        `SELECT f.vendor AS from_vendor, t.vendor AS to_vendor FROM handoffs h
         JOIN runs f ON f.id = h.from_run JOIN runs t ON t.id = h.to_run`,
      )
      .get();
    expect(link).toEqual({ from_vendor: "claude-code", to_vendor: "codex" });
  });

  test("the author reading its own packet is not a receiver", () => {
    const { db, agent } = setup();
    handoffCreate(agent, db, FIELDS);
    handoffRead(agent, db, "h-1");
    expect(db.query("SELECT to_run FROM handoffs").get()).toEqual({ to_run: null });
  });
});
