import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FsSink } from "../lib/sinks.ts";
import { ALL_SCOPES, AuditLog, type Client, Controls, RateLimiter } from "./policy.ts";
import { localStateDir, StoreHolder } from "./runtime.ts";
import { createServer } from "./server.ts";

/**
 * Local MCP over stdio for Claude Code and Codex. No network port is opened.
 * The local user gets every scope, including sensitive concepts.
 */
export async function serveStdio(root: string, clientId = "local"): Promise<void> {
  const holder = await StoreHolder.open(root);
  const state = localStateDir();
  const client: Client = { id: clientId, scopes: ALL_SCOPES, hosted: false };
  const server = createServer({
    store: () => holder.current,
    sink: new FsSink(holder.root),
    client,
    limiter: new RateLimiter(),
    controls: new Controls(join(state, "controls.json")),
    audit: new AuditLog(join(state, "audit.jsonl")),
  });
  await server.connect(new StdioServerTransport());
}
