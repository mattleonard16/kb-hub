import { createHmac, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { shortHash } from "../lib/inbox.ts";
import type { InboxSink } from "../lib/sinks.ts";
import { type OAuthServer, RESOURCES, SCOPE_GRANTS } from "./oauth.ts";
import { type AuditLog, type Client, type Controls, RateLimiter, type Scope } from "./policy.ts";
import type { StoreHolder } from "./runtime.ts";
import { createServer } from "./server.ts";

export type HttpDeps = {
  holder: StoreHolder;
  oauth: OAuthServer;
  sink: InboxSink;
  controls: Controls;
  audit: AuditLog;
  /** Runs before a reload on webhook, e.g. `git pull`. */
  refresh?: () => Promise<void>;
  webhookSecret?: string;
  /** Browser origins allowed to call /mcp (server-to-server calls send none). */
  allowedOrigins?: string[];
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
};

/** Which scopes each endpoint may use, whatever the token holds. */
const ENDPOINT_SCOPES: Record<(typeof RESOURCES)[number], Scope[]> = {
  "/mcp/read": [...(SCOPE_GRANTS.read ?? [])],
  "/mcp/write": [...(SCOPE_GRANTS.read ?? []), ...(SCOPE_GRANTS.write ?? [])],
};

function withHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function verifyWebhook(secret: string, body: string, sig: string | null): boolean {
  if (!sig?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Build the fetch handler for Bun.serve (or any Web-standard host). Stateless per request. */
export function createHandler(deps: HttpDeps) {
  const limiter = new RateLimiter();
  const origins = new Set(deps.allowedOrigins ?? []);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/healthz")
      return withHeaders(Response.json({ ok: true, concepts: deps.holder.current.size }));

    if (path === "/.well-known/oauth-authorization-server")
      return withHeaders(deps.oauth.serverMetadata());
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      const res = path.slice("/.well-known/oauth-protected-resource".length) || "/mcp/read";
      if (!RESOURCES.includes(res as (typeof RESOURCES)[number]))
        return new Response("Not found", { status: 404 });
      return withHeaders(deps.oauth.resourceMetadata(res));
    }
    if (path === "/oauth/register" && req.method === "POST")
      return withHeaders(await deps.oauth.register(req));
    if (path === "/oauth/authorize" && req.method === "GET")
      return withHeaders(deps.oauth.authorize(url));
    if (path === "/oauth/github/callback") return withHeaders(await deps.oauth.callback(url));
    if (path === "/oauth/token" && req.method === "POST")
      return withHeaders(await deps.oauth.token(req));

    if (path === "/hooks/github" && req.method === "POST") {
      const body = await req.text();
      if (
        !deps.webhookSecret ||
        !verifyWebhook(deps.webhookSecret, body, req.headers.get("x-hub-signature-256"))
      ) {
        return new Response("bad signature", { status: 401 });
      }
      await deps.refresh?.();
      const r = await deps.holder.reload();
      return withHeaders(Response.json({ reloaded: true, ...r }));
    }

    if (RESOURCES.includes(path as (typeof RESOURCES)[number])) {
      const endpoint = path as (typeof RESOURCES)[number];
      const origin = req.headers.get("origin");
      if (origin && !origins.has(origin))
        return new Response("Origin not allowed", { status: 403 });
      const auth = deps.oauth.authenticate(req.headers.get("authorization"), endpoint);
      if (!auth) return withHeaders(deps.oauth.challenge(endpoint));

      const tokenScopes = auth.scopes.flatMap((s) => SCOPE_GRANTS[s] ?? []);
      const client: Client = {
        id: `web:${auth.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 24)}-${shortHash(auth.cid).slice(0, 6)}`,
        scopes: ENDPOINT_SCOPES[endpoint].filter((s) => tokenScopes.includes(s)),
        hosted: true,
      };
      const server = createServer({
        store: () => deps.holder.current,
        sink: deps.sink,
        client,
        limiter,
        controls: deps.controls,
        audit: deps.audit,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return withHeaders(await transport.handleRequest(req));
    }

    return new Response("Not found", { status: 404 });
  };
}
