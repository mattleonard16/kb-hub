import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { FsSink, GitHubSink, type InboxSink } from "../lib/sinks.ts";
import { createHandler } from "./http.ts";
import { OAuthServer } from "./oauth.ts";
import { AuditLog, Controls } from "./policy.ts";
import { localStateDir, StoreHolder } from "./runtime.ts";
import { fetchSnapshot } from "./snapshot.ts";

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required for kb serve --http. See .env.example.`);
  return v;
}

/** Start the hosted server. Configuration comes only from environment variables. */
export async function serveHttp(
  root: string,
  env = process.env,
): Promise<{ port: number; stop: () => void }> {
  const refresh = await knowledgeSource(root, env);
  await refresh();
  const holder = await StoreHolder.open(root);
  const oauth = new OAuthServer({
    baseUrl: need(env, "KB_PUBLIC_URL").replace(/\/+$/, ""),
    signingKey: need(env, "KB_SIGNING_KEY"),
    githubClientId: need(env, "KB_GITHUB_OAUTH_CLIENT_ID"),
    githubClientSecret: need(env, "KB_GITHUB_OAUTH_CLIENT_SECRET"),
    allowedLogin: need(env, "KB_ALLOWED_GITHUB_LOGIN"),
  });
  const sink: InboxSink =
    env.KB_GITHUB_REPO && env.KB_GITHUB_TOKEN
      ? new GitHubSink(env.KB_GITHUB_REPO, env.KB_GITHUB_TOKEN, env.KB_INBOX_BRANCH ?? "inbox")
      : new FsSink(holder.root);
  const state = localStateDir(env);
  const handler = createHandler({
    holder,
    oauth,
    sink,
    controls: new Controls(join(state, "controls.json"), env),
    audit: new AuditLog(env.KB_AUDIT_LOG),
    webhookSecret: env.KB_WEBHOOK_SECRET,
    allowedOrigins: (env.KB_ALLOWED_ORIGINS ?? "https://chatgpt.com,https://claude.ai")
      .split(",")
      .map((s) => s.trim()),
    refresh,
  });
  const server = Bun.serve({
    port: Number(env.PORT ?? 8787),
    hostname: env.KB_BIND ?? "0.0.0.0",
    maxRequestBodySize: 256 * 1024,
    fetch: handler,
  });
  return { port: server.port ?? 0, stop: () => server.stop() };
}

/**
 * Where the served knowledge comes from. With KB_GITHUB_REPO and KB_GITHUB_READ_TOKEN set, it is a
 * zipball of the repo's main branch, fetched on start and on each signed webhook (no git, no disk
 * needed, so it runs on Cloud Run, Vercel or Fly alike). Otherwise it is a local checkout, pulled
 * on webhook if it is a git repo.
 */
async function knowledgeSource(root: string, env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  const repo = env.KB_GITHUB_REPO;
  const token = env.KB_GITHUB_READ_TOKEN;
  if (repo && token) {
    return async () => {
      const r = await fetchSnapshot({
        repo,
        token,
        dest: root,
        ref: env.KB_KNOWLEDGE_REF ?? "main",
        apiBase: env.KB_GITHUB_API,
      });
      console.error(`kb-hub: loaded ${r.files} files from ${repo}@${r.ref}`);
    };
  }
  return async () => {
    if (existsSync(join(root, ".git"))) await $`git -C ${root} pull --ff-only --quiet`.quiet();
  };
}
