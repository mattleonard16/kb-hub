import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Scope } from "./policy.ts";

/**
 * A small, stateless OAuth 2.1 authorization server for the hosted MCP endpoint
 * (the MCP authorization spec: PKCE S256, dynamic client registration, protected
 * resource metadata, audience-bound tokens). Identity comes from GitHub, and only
 * the one allowed login can finish sign-in. Every artifact (client id, state, code,
 * token) is an HMAC-signed blob, so the server stores nothing and can run anywhere.
 */

export type OAuthConfig = {
  /** Public base URL, e.g. https://kb-hub.fly.dev (no trailing slash). */
  baseUrl: string;
  signingKey: string;
  githubClientId: string;
  githubClientSecret: string;
  allowedLogin: string;
  accessTtlSec?: number;
  refreshTtlSec?: number;
};

export type GitHubApi = {
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  login(accessToken: string): Promise<string>;
};

export const githubApi = (clientId: string, clientSecret: string): GitHubApi => ({
  async exchangeCode(code, redirectUri) {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) throw new Error(`GitHub sign-in failed: ${data.error ?? res.status}`);
    return data.access_token;
  },
  async login(token) {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub user lookup failed: ${res.status}`);
    return ((await res.json()) as { login: string }).login;
  },
});

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(
  key: string,
  payload: Record<string, unknown>,
  ttlSec?: number,
  now = Date.now(),
): string {
  const body = {
    ...payload,
    iat: Math.floor(now / 1000),
    ...(ttlSec ? { exp: Math.floor(now / 1000) + ttlSec } : {}),
  };
  const data = b64u(JSON.stringify(body));
  const mac = createHmac("sha256", key).update(data).digest("base64url");
  return `${data}.${mac}`;
}

export function verify<T extends Record<string, unknown>>(
  key: string,
  token: string,
  typ: string,
  now = Date.now(),
): T | null {
  const [data, mac] = token.split(".");
  if (!data || !mac) return null;
  const expected = createHmac("sha256", key).update(data).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(data, "base64url").toString()) as T & {
      typ?: string;
      exp?: number;
    };
    if (body.typ !== typ) return null;
    if (body.exp && body.exp * 1000 < now) return null;
    return body;
  } catch {
    return null;
  }
}

export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

/** OAuth scope strings clients request, and what they grant. */
export const SCOPE_GRANTS: Record<string, Scope[]> = {
  read: ["read:public", "read:personal"],
  write: ["write:flags", "write:ingest"],
};

export function grantedScopes(requested: string | null | undefined): string[] {
  const asked = (requested ?? "read").split(/\s+/).filter((s) => s in SCOPE_GRANTS);
  return asked.length ? [...new Set(asked)] : ["read"];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return (
      u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    );
  } catch {
    return false;
  }
}

export const RESOURCES = ["/mcp/read", "/mcp/write"] as const;

export class OAuthServer {
  readonly accessTtl: number;
  readonly refreshTtl: number;

  constructor(
    private cfg: OAuthConfig,
    private gh: GitHubApi = githubApi(cfg.githubClientId, cfg.githubClientSecret),
    private clock: () => number = Date.now,
  ) {
    if (cfg.signingKey.length < 32)
      throw new Error("KB_SIGNING_KEY must be at least 32 characters");
    this.accessTtl = cfg.accessTtlSec ?? 3600;
    this.refreshTtl = cfg.refreshTtlSec ?? 30 * 86400;
  }

  get callbackUrl(): string {
    return `${this.cfg.baseUrl}/oauth/github/callback`;
  }

  resourceMetadata(path: string): Response {
    const resource = `${this.cfg.baseUrl}${path}`;
    return json({
      resource,
      authorization_servers: [this.cfg.baseUrl],
      scopes_supported: Object.keys(SCOPE_GRANTS),
      bearer_methods_supported: ["header"],
    });
  }

  serverMetadata(): Response {
    const b = this.cfg.baseUrl;
    return json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: Object.keys(SCOPE_GRANTS),
    });
  }

  /** Dynamic client registration (RFC 7591). The client id is a signed record of its redirect URIs. */
  async register(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as {
      redirect_uris?: unknown;
      client_name?: unknown;
    } | null;
    const uris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
      return oauthError(
        "invalid_redirect_uri",
        "redirect_uris must be 1 to 10 https (or localhost) URLs",
      );
    }
    const name =
      typeof body?.client_name === "string" ? body.client_name.slice(0, 60) : "mcp-client";
    const client_id = sign(
      this.cfg.signingKey,
      { typ: "client", uris, name },
      undefined,
      this.clock(),
    );
    return json(
      {
        client_id,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  private client(clientId: string | null) {
    return clientId
      ? verify<{ uris: string[]; name: string }>(
          this.cfg.signingKey,
          clientId,
          "client",
          this.clock(),
        )
      : null;
  }

  /** Step 1: validate the client's request, then send the user to GitHub. */
  authorize(url: URL): Response {
    const p = url.searchParams;
    const client = this.client(p.get("client_id"));
    const redirect = p.get("redirect_uri") ?? "";
    if (!client?.uris.includes(redirect)) {
      return new Response("Unknown client or redirect_uri not registered.", { status: 400 });
    }
    if (p.get("response_type") !== "code")
      return new Response("response_type must be code", { status: 400 });
    const challenge = p.get("code_challenge");
    if (!challenge || p.get("code_challenge_method") !== "S256") {
      return new Response("PKCE with code_challenge_method=S256 is required", { status: 400 });
    }
    const resource = p.get("resource") ?? undefined;
    if (resource && !RESOURCES.some((r) => resource === `${this.cfg.baseUrl}${r}`)) {
      return new Response("Unknown resource", { status: 400 });
    }
    const state = sign(
      this.cfg.signingKey,
      {
        typ: "gh-state",
        cid: p.get("client_id"),
        redirect,
        challenge,
        state: p.get("state"),
        scope: grantedScopes(p.get("scope")).join(" "),
        resource,
      },
      600,
      this.clock(),
    );
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", this.cfg.githubClientId);
    gh.searchParams.set("redirect_uri", this.callbackUrl);
    gh.searchParams.set("state", state);
    gh.searchParams.set("scope", "read:user");
    gh.searchParams.set("allow_signup", "false");
    return Response.redirect(gh.toString(), 302);
  }

  /** Step 2: GitHub sends the user back. Only the allowed login gets a code. */
  async callback(url: URL): Promise<Response> {
    const st = verify<{
      cid: string;
      redirect: string;
      challenge: string;
      state: string | null;
      scope: string;
      resource?: string;
    }>(this.cfg.signingKey, url.searchParams.get("state") ?? "", "gh-state", this.clock());
    const code = url.searchParams.get("code");
    if (!st || !code)
      return new Response("Sign-in expired or invalid. Start again from your app.", {
        status: 400,
      });
    const token = await this.gh.exchangeCode(code, this.callbackUrl);
    const login = await this.gh.login(token);
    if (login.toLowerCase() !== this.cfg.allowedLogin.toLowerCase()) {
      return new Response("This knowledge hub belongs to someone else.", { status: 403 });
    }
    const authCode = sign(
      this.cfg.signingKey,
      {
        typ: "code",
        cid: st.cid,
        redirect: st.redirect,
        challenge: st.challenge,
        scope: st.scope,
        resource: st.resource,
        sub: login,
      },
      300,
      this.clock(),
    );
    const back = new URL(st.redirect);
    back.searchParams.set("code", authCode);
    if (st.state) back.searchParams.set("state", st.state);
    return Response.redirect(back.toString(), 302);
  }

  private issue(
    sub: string,
    cid: string,
    scope: string,
    resource: string | undefined,
    name: string,
  ) {
    const now = this.clock();
    const base = { sub, cid, scope, aud: resource ?? this.cfg.baseUrl, name };
    return json({
      access_token: sign(this.cfg.signingKey, { typ: "access", ...base }, this.accessTtl, now),
      token_type: "Bearer",
      expires_in: this.accessTtl,
      refresh_token: sign(this.cfg.signingKey, { typ: "refresh", ...base }, this.refreshTtl, now),
      scope,
    });
  }

  /** Step 3: code (with PKCE verifier) or refresh token for an access token. */
  async token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const grant = form.get("grant_type");
    const cid = form.get("client_id") ?? "";
    const client = this.client(cid);
    if (!client) return oauthError("invalid_client", "unknown client_id", 401);

    if (grant === "authorization_code") {
      const code = verify<{
        cid: string;
        redirect: string;
        challenge: string;
        scope: string;
        resource?: string;
        sub: string;
      }>(this.cfg.signingKey, form.get("code") ?? "", "code", this.clock());
      if (!code || code.cid !== cid)
        return oauthError("invalid_grant", "code is invalid or expired");
      if (code.redirect !== form.get("redirect_uri"))
        return oauthError("invalid_grant", "redirect_uri mismatch");
      const verifier = form.get("code_verifier") ?? "";
      if (verifier.length < 43 || pkceChallenge(verifier) !== code.challenge)
        return oauthError("invalid_grant", "PKCE verification failed");
      const resource = form.get("resource") ?? code.resource;
      if (code.resource && resource !== code.resource)
        return oauthError("invalid_target", "resource mismatch");
      return this.issue(code.sub, cid, code.scope, resource, client.name);
    }

    if (grant === "refresh_token") {
      const rt = verify<{ cid: string; sub: string; scope: string; aud: string }>(
        this.cfg.signingKey,
        form.get("refresh_token") ?? "",
        "refresh",
        this.clock(),
      );
      if (!rt || rt.cid !== cid)
        return oauthError("invalid_grant", "refresh token is invalid or expired");
      return this.issue(rt.sub, cid, rt.scope, rt.aud, client.name);
    }

    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  /** Validate a bearer token for a resource path. Returns the caller or null. */
  authenticate(
    header: string | null,
    path: string,
  ): { sub: string; cid: string; name: string; scopes: string[] } | null {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    const t = verify<{ sub: string; cid: string; scope: string; aud: string; name: string }>(
      this.cfg.signingKey,
      token,
      "access",
      this.clock(),
    );
    if (!t) return null;
    const resource = `${this.cfg.baseUrl}${path}`;
    if (t.aud !== resource && t.aud !== this.cfg.baseUrl) return null; // audience-bound: no token reuse across services
    if (t.sub.toLowerCase() !== this.cfg.allowedLogin.toLowerCase()) return null;
    return { sub: t.sub, cid: t.cid, name: t.name, scopes: t.scope.split(" ") };
  }

  challenge(path: string): Response {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        error_description: "Sign in with OAuth to use this server.",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${this.cfg.baseUrl}/.well-known/oauth-protected-resource${path}"`,
        },
      },
    );
  }
}
