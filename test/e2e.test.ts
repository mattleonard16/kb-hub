import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { main } from "../src/cli.ts";
import { compileAll } from "../src/compile/compile.ts";
import { listInbox, markProcessed } from "../src/curator/inbox.ts";
import { promote } from "../src/curator/promote.ts";
import { loadKnowledge } from "../src/index/load.ts";
import { ingestReply } from "../src/ingest/ingest.ts";
import { FsSink } from "../src/lib/sinks.ts";
import { lintKnowledge } from "../src/lint/lint.ts";
import { ALL_SCOPES, AuditLog, Controls, RateLimiter } from "../src/mcp/policy.ts";
import { StoreHolder } from "../src/mcp/runtime.ts";
import { createServer } from "../src/mcp/server.ts";
import { fixtureText, quiet, tempDir } from "./helpers.ts";

/**
 * The whole loop on a fresh knowledge repo: an assistant's extraction reply goes into the
 * inbox, the curator turns it into a draft concept, the user approves (promote), compile
 * delivers it, an agent finds it over MCP and flags a gap, and the flag lands back in the inbox.
 */
describe("end to end", () => {
  test("extraction -> inbox -> curator -> approve -> compile -> MCP -> flag -> inbox", async () => {
    const root = join(await tempDir(), "knowledge");
    expect(await quiet(() => main(["init", root]))).toBe(0);
    const sink = new FsSink(root);

    // 1. Ingest: the pasted reply is stored as-is in the inbox. A second paste is a no-op.
    const reply = await fixtureText("extraction-chatgpt.yaml");
    const stored = await ingestReply(sink, `\`\`\`yaml\n${reply}\`\`\``, { tool: "chatgpt" });
    expect(stored.created).toBe(true);
    expect(
      (await ingestReply(sink, `\`\`\`yaml\n${reply}\`\`\``, { tool: "chatgpt" })).created,
    ).toBe(false);
    const { entries } = await listInbox(root);
    expect(entries.map((e) => e.path)).toEqual([stored.path]);

    // 2. Curator: one concept per item, as a draft, sourced to where the inbox file will end up.
    const processed = stored.path.replace(/^inbox\//, "inbox/processed/");
    const concept = join(root, "knowledge/profile/short-replies.md");
    await writeFile(
      concept,
      [
        "---",
        "type: preference",
        "title: Prefers short replies",
        "description: Under 150 words unless asked for depth.",
        "scope: global",
        "status: draft",
        "sensitivity: personal",
        "confidence: high",
        "stale_after: 2027-11-22",
        "sources:",
        `  - resource: ${processed}`,
        "    origin: memory",
        "generated: { by: agent:claude-curator, at: 2026-11-22 }",
        "---",
        "Keep answers under 150 words unless asked for depth.",
        "",
      ].join("\n"),
    );
    await markProcessed(
      root,
      [stored.path],
      "Merged ChatGPT export",
      new Date("2026-11-22T12:00:00Z"),
    );
    expect((await listInbox(root)).entries).toHaveLength(0);
    expect((await lintKnowledge(root)).ok).toBe(true);

    // A draft is searchable but not always-on.
    let built = await compileAll(root, await loadKnowledge(root));
    expect(built.outputs.claude?.concepts).toEqual([]);

    // 3. Approve: the post-label workflow runs promote, then compile.
    await promote([concept], "human:mattleonard16", new Date("2026-11-23T00:00:00Z"));
    built = await compileAll(root, await loadKnowledge(root));
    expect(built.outputs.claude?.concepts).toEqual(["profile/short-replies"]);
    const claudeMd = await readFile(join(root, "build/claude.md"), "utf8");
    expect(claudeMd).toContain("Keep answers under 150 words unless asked for depth.");

    // 4. Serve: an agent finds it by asking a question, then flags what's missing.
    const holder = await StoreHolder.open(root);
    const server = createServer({
      store: () => holder.current,
      sink,
      client: { id: "claude-code", scopes: ALL_SCOPES, hosted: false },
      limiter: new RateLimiter(),
      controls: new Controls(),
      audit: new AuditLog(join(await tempDir(), "audit.jsonl")),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new McpClient({ name: "e2e", version: "1" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    const search = (await mcp.callTool({
      name: "search_knowledge",
      arguments: { query: "how long should my replies be?" },
    })) as unknown as { structuredContent: { results: Array<{ id: string; verified: boolean }> } };
    expect(search.structuredContent.results[0]).toMatchObject({
      id: "profile/short-replies",
      verified: true,
    });
    const flag = (await mcp.callTool({
      name: "flag_knowledge",
      arguments: {
        kind: "missing",
        query: "Which calendar is the work one?",
        what_happened: "Asked to schedule a meeting; the knowledge base has no calendar info.",
      },
    })) as unknown as { structuredContent: { path: string } };
    await mcp.close();

    // 5. Back to the inbox, attributed to the authenticated client, for the next curator run.
    const next = await listInbox(root);
    expect(next.entries.map((e) => [e.kind, e.path])).toEqual([
      ["flag", flag.structuredContent.path],
    ]);
    const flagText = await readFile(join(root, flag.structuredContent.path), "utf8");
    expect(flagText).toContain("reported_by: claude-code");
    expect((await lintKnowledge(root)).ok).toBe(true);
  });
});
