import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { FsSink } from "../src/lib/sinks.ts";
import { createHandler } from "../src/mcp/http.ts";
import { type GitHubApi, OAuthServer, pkceChallenge, sign, verify } from "../src/mcp/oauth.ts";
import { AuditLog, Controls } from "../src/mcp/policy.ts";
import { StoreHolder } from "../src/mcp/runtime.ts";
import { tempDir, tempKnowledge } from "./helpers.ts";

const BASE = "https://kb.example.com";
const KEY = "k".repeat(40);
const VERIFIER = "v".repeat(64);
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

function fakeGitHub(login: string): GitHubApi {
  return { exchangeCode: async () => "gh-token", login: async () => login };
}

async function setup(login = "mattleonard16", clock = Date.now) {
  const root = await tempKnowledge();
  const holder = await StoreHolder.open(root);
  const oauth = new OAuthServer(
    {
      baseUrl: BASE,
      signingKey: KEY,
      githubClientId: "id",
      githubClientSecret: "secret",
      allowedLogin: "mattleonard16",
    },
    fakeGitHub(login),
    clock,
  );
  const handle = createHandler({
    holder,
    oauth,
    sink: new FsSink(root),
    controls: new Controls(),
    audit: new AuditLog(join(await tempDir(), "audit.jsonl")),
    webhookSecret: "whsec",
    allowedOrigins: ["https://chatgpt.com"],
  });
  const req = (path: string, init?: RequestInit) => handle(new Request(`${BASE}${path}`, init));
  return { req, root };
}

/** Run the whole OAuth dance the way ChatGPT or Claude would. */
async function signIn(
  req: (p: string, i?: RequestInit) => Promise<Response>,
  scope = "read write",
  resource = `${BASE}/mcp/write`,
) {
  const reg = await req("/oauth/register", {
    method: "POST",
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "ChatGPT" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    state: "xyz",
    scope,
    resource,
  });
  const toGitHub = await req(`/oauth/authorize?${q}`);
  const ghState = new URL(toGitHub.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await req(
    `/oauth/github/callback?code=gh-code&state=${encodeURIComponent(ghState)}`,
  );
  return { client_id, back };
}

async function exchange(
  req: (p: string, i?: RequestInit) => Promise<Response>,
  client_id: string,
  back: Response,
  verifier = VERIFIER,
) {
  const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
  return req("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
}

const rpc = (method: string, params: object = {}, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const mcpHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
});

describe("signed tokens", () => {
  test("verify checks signature, type and expiry", () => {
    const t = sign(KEY, { typ: "access", sub: "a" }, 60, 1_000_000);
    expect(verify(KEY, t, "access", 1_000_000)).toMatchObject({ sub: "a" });
    expect(verify(KEY, t, "refresh", 1_000_000)).toBeNull();
    expect(verify(KEY, t, "access", 1_000_000 + 61_000)).toBeNull();
    expect(verify(`${KEY}x`, t, "access", 1_000_000)).toBeNull();
    expect(verify(KEY, `${t.split(".")[0]}.AAAA`, "access", 1_000_000)).toBeNull();
  });
});

describe("hosted MCP with OAuth", () => {
  test("advertises metadata and challenges unauthenticated calls", async () => {
    const { req } = await setup();
    const meta = (await (await req("/.well-known/oauth-authorization-server")).json()) as Record<
      string,
      unknown
    >;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    const prm = (await (
      await req("/.well-known/oauth-protected-resource/mcp/read")
    ).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${BASE}/mcp/read`);
    const r = await req("/mcp/read", { method: "POST", body: rpc("tools/list") });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  test("full sign-in, then tools respect endpoint and token scopes", async () => {
    const { req } = await setup();
    const { client_id, back } = await signIn(req);
    expect(back.status).toBe(302);
    const tok = (await (await exchange(req, client_id, back)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(tok.access_token).toBeTruthy();

    const list = await req("/mcp/write", {
      method: "POST",
      headers: mcpHeaders(tok.access_token),
      body: rpc("tools/list"),
    });
    expect(list.status).toBe(200);
    const names = (
      (await list.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "add_source",
      "flag_knowledge",
      "get_concept",
      "ingest",
      "search_knowledge",
    ]);

    const search = await req("/mcp/write", {
      method: "POST",
      headers: mcpHeaders(tok.access_token),
      body: rpc("tools/call", { name: "search_knowledge", arguments: { query: "peanut" } }),
    });
    const sc = ((await search.json()) as { result: { structuredContent: { total: number } } })
      .result.structuredContent;
    expect(sc.total).toBe(0); // sensitive never served when hosted

    // Token bound to /mcp/write cannot be replayed at /mcp/read.
    expect(
      (
        await req("/mcp/read", {
          method: "POST",
          headers: mcpHeaders(tok.access_token),
          body: rpc("tools/list"),
        })
      ).status,
    ).toBe(401);

    const refreshed = await req("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tok.refresh_token,
        client_id,
      }),
    });
    expect(refreshed.status).toBe(200);
  });

  test("read-only token on the read endpoint gets read tools only", async () => {
    const { req } = await setup();
    const { client_id, back } = await signIn(req, "read", `${BASE}/mcp/read`);
    const tok = (await (await exchange(req, client_id, back)).json()) as { access_token: string };
    const list = await req("/mcp/read", {
      method: "POST",
      headers: mcpHeaders(tok.access_token),
      body: rpc("tools/list"),
    });
    const names = (
      (await list.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["get_concept", "search_knowledge"]);
  });

  test("rejects other GitHub users, bad PKCE, bad redirects and foreign origins", async () => {
    const other = await setup("someone-else");
    const { back } = await signIn(other.req);
    expect(back.status).toBe(403);

    const { req } = await setup();
    const s = await signIn(req);
    expect((await exchange(req, s.client_id, s.back, "w".repeat(64))).status).toBe(400);

    const reg = await req("/oauth/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }),
    });
    expect(reg.status).toBe(400);

    const ok = await signIn(req);
    const tok = (await (await exchange(req, ok.client_id, ok.back)).json()) as {
      access_token: string;
    };
    const foreign = await req("/mcp/write", {
      method: "POST",
      headers: { ...mcpHeaders(tok.access_token), origin: "https://evil.com" },
      body: rpc("tools/list"),
    });
    expect(foreign.status).toBe(403);
  });

  test("webhook needs a valid signature and reloads the index", async () => {
    const { req, root } = await setup();
    expect((await req("/hooks/github", { method: "POST", body: "{}" })).status).toBe(401);
    await Bun.write(
      join(root, "wiki/profile/x.md"),
      "---\ntype: fact\ntitle: X\nscope: global\nstatus: draft\nsensitivity: public\nconfidence: low\nsources:\n  - resource: inbox/x.yaml\n---\nX.\n",
    );
    const body = "{}";
    const sig = `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`;
    const r = await req("/hooks/github", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sig },
    });
    expect(((await r.json()) as { concepts: number }).concepts).toBe(8);
    expect(((await (await req("/healthz")).json()) as { concepts: number }).concepts).toBe(8);
  });
});
