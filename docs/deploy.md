# Deploy the hosted MCP server (Fly.io)

The hosted server lets Claude web (and Duet) and ChatGPT web reach your knowledge base. It is stateless: it clones the knowledge repo on start, pulls on each merge (webhook), and writes flags to the `inbox` branch through the GitHub API. The same container runs anywhere that runs Docker.

## 1. GitHub pieces

1. **OAuth app** (github.com/settings/developers): homepage `https://<app>.fly.dev`, callback `https://<app>.fly.dev/oauth/github/callback`.
2. **Read token**: fine-grained, only the `knowledge` repo, Contents: read.
3. **Write token**: fine-grained, only the `knowledge` repo, Contents: read and write. It can only reach the `inbox` branch in practice because `main` is protected.

## 2. Fly

```sh
fly launch --no-deploy --copy-config --name <app>
fly secrets set \
  KB_PUBLIC_URL=https://<app>.fly.dev \
  KB_SIGNING_KEY="$(openssl rand -base64 48)" \
  KB_GITHUB_OAUTH_CLIENT_ID=... KB_GITHUB_OAUTH_CLIENT_SECRET=... \
  KB_ALLOWED_GITHUB_LOGIN=<your-login> \
  KB_GITHUB_REPO=<you>/knowledge KB_GITHUB_READ_TOKEN=... KB_GITHUB_TOKEN=... \
  KB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
fly deploy
curl https://<app>.fly.dev/healthz
```

## 3. Webhook

In the knowledge repo: Settings, Webhooks, add `https://<app>.fly.dev/hooks/github`, content type JSON, secret = `KB_WEBHOOK_SECRET`, push events only.

## 4. Connect the web apps

| App | Where | URL |
| --- | --- | --- |
| Claude web (also Duet) | Settings, Connectors, add custom connector | `https://<app>.fly.dev/mcp/read` first; `/mcp/write` once you want flagging |
| ChatGPT web | Settings, Apps, developer mode, add custom MCP server | same |

Both run the OAuth sign-in; only `KB_ALLOWED_GITHUB_LOGIN` can finish it. Tokens last an hour and refresh for 30 days.

## Endpoints and limits

- `/mcp/read`: `search_knowledge`, `get_concept`, `kb://profile`. Read-only.
- `/mcp/write`: the read tools plus `flag_knowledge` and `ingest`.
- Concepts marked `sensitive` are never served here.
- 60 calls a minute and 50 writes a day per client.
- Kill switch: `fly secrets set KB_LOCKDOWN=read-only` (or `closed`). Revoke one client: `KB_REVOKED_CLIENTS=<id>` (ids are in the audit log).

## Not yet verified

The Docker image and Fly config have not been deployed yet. Vercel would need its Bun runtime and a deploy-time index; the code is stateless so it should port.
