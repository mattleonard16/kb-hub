import { describe, expect, test } from "bun:test";
import { detectIdentity } from "../src/lib/identity.ts";
import { sanitize, tailBytes, truncateBytes } from "../src/lib/sanitize.ts";
import { findSecrets } from "../src/lib/secrets.ts";

describe("sanitize", () => {
  test("drops env-like KEY=VALUE lines and keeps the rest", () => {
    const out = sanitize(
      "3 pass\nDATABASE_URL=postgres://u:p@h/db\nexport API_TOKEN=abc\n  set FOO=bar\n1 fail\nexpected a == b",
    );
    expect(out).toBe("3 pass\n1 fail\nexpected a == b");
  });

  test("redacts secrets inside ordinary lines", () => {
    const key = `sk-ant-${"a".repeat(30)}`;
    const out = sanitize(`request failed with key ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("[redacted:anthropic-key]");
    expect(findSecrets(out)).toEqual([]);
  });

  test("truncates to the byte limit and marks the cut", () => {
    const out = sanitize("x".repeat(10_000), 100);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(100);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  test("never splits a multi-byte character", () => {
    const out = truncateBytes("é".repeat(100), 51);
    expect(out).not.toContain("�");
    expect(tailBytes("é".repeat(100), 51)).not.toContain("�");
  });
});

describe("detectIdentity", () => {
  test("Claude Code from its env signals", () => {
    const id = detectIdentity({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s1",
      CLAUDE_CODE_VERSION: "2.1.0",
    });
    expect(id).toEqual({
      vendor: "claude-code",
      model: "unknown",
      session_id: "s1",
      cli_version: "2.1.0",
      agent: true,
    });
  });

  test("Codex from its thread id", () => {
    const id = detectIdentity({ CODEX_THREAD_ID: "t1" });
    expect(id.vendor).toBe("codex");
    expect(id.session_id).toBe("t1");
    expect(id.agent).toBe(true);
  });

  test("no signals means the person, recorded as unknown", () => {
    expect(detectIdentity({})).toEqual({
      vendor: "unknown",
      model: "unknown",
      session_id: "unknown",
      cli_version: null,
      agent: false,
    });
  });
});
