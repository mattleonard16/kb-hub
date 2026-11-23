# Deploy the hosted MCP server

The hosted server lets Claude web (and Duet) and ChatGPT web reach your knowledge base. It is stateless:

- On start, and on each signed webhook after a merge, it downloads the knowledge repo's `main` branch as one zipball into a temp folder and rebuilds the in-memory index. It needs no git and no persistent disk.
- Flags and ingests go to the `inbox` branch through the GitHub API.
- OAuth state lives in signed tokens, so any instance can answer any request.

So the same image runs on any container host. The choice of host is open; see the comparison doc linked from the PR. Steps 1, 3 and 4 are the same everywhere.

## 1. GitHub pieces

1. **OAuth app** (github.com/settings/developers): homepage `<URL>`, callback `<URL>/oauth/github/callback`, where `<URL>` is the public URL your host gives you.
2. **Read token**: fine-grained, only the `knowledge` repo, Contents: read.
3. **Write token**: fine-grained, only the `knowledge` repo, Contents: read and write. In practice it reaches only the `inbox` branch, because `main` is protected.

Settings (all from the environment, see `.env.example`):

| Variable | Value |
| --- | --- |
| `KB_PUBLIC_URL` | The public URL, no trailing slash |
| `KB_SIGNING_KEY` | `openssl rand -base64 48` |
| `KB_GITHUB_OAUTH_CLIENT_ID`, `KB_GITHUB_OAUTH_CLIENT_SECRET` | From the OAuth app |
| `KB_ALLOWED_GITHUB_LOGIN` | Your GitHub login, the only one that can sign in |
| `KB_GITHUB_REPO` | `<you>/knowledge` |
| `KB_GITHUB_READ_TOKEN`, `KB_GITHUB_TOKEN` | The read and write tokens |
| `KB_WEBHOOK_SECRET` | `openssl rand -hex 32` |

Treat every value except `KB_PUBLIC_URL`, `KB_ALLOWED_GITHUB_LOGIN` and `KB_GITHUB_REPO` as a secret, and use the host's secret store.

## 2. Host

Run one instance at most. Rate limits and the daily write budget are counted in memory, so more instances would each get their own budget, and a restart resets it.

### Google Cloud Run

```sh
gcloud run deploy kb-hub --source . --region us-east4 \
  --allow-unauthenticated --min-instances 0 --max-instances 1 --memory 512Mi \
  --set-env-vars KB_ALLOWED_GITHUB_LOGIN=<you>,KB_GITHUB_REPO=<you>/knowledge \
  --set-secrets KB_SIGNING_KEY=kb-signing-key:latest,KB_GITHUB_OAUTH_CLIENT_SECRET=kb-oauth-secret:latest,KB_GITHUB_READ_TOKEN=kb-read-token:latest,KB_GITHUB_TOKEN=kb-write-token:latest,KB_WEBHOOK_SECRET=kb-webhook-secret:latest \
  --set-env-vars KB_GITHUB_OAUTH_CLIENT_ID=<id>
URL=$(gcloud run services describe kb-hub --region us-east4 --format 'value(status.url)')
gcloud run services update kb-hub --region us-east4 --update-env-vars KB_PUBLIC_URL=$URL
curl $URL/healthz
```

Create each secret first with `printf %s "<value>" | gcloud secrets create <name> --data-file=-`. `--allow-unauthenticated` is required because Claude and ChatGPT call the server directly. The server's own OAuth is what protects it. Kill switch: `gcloud run services update kb-hub --update-env-vars KB_LOCKDOWN=read-only` (or `closed`).

### Fly.io

```sh
fly launch --no-deploy --copy-config --name <app>
fly secrets set KB_PUBLIC_URL=https://<app>.fly.dev KB_SIGNING_KEY=... # and the rest of the table
fly deploy
fly scale count 1   # fly deploy starts two machines by default
curl https://<app>.fly.dev/healthz
```

`fly.toml` stops the machine when idle and starts it on the next request. Kill switch: `fly secrets set KB_LOCKDOWN=read-only`.

### Anything else that runs a container

Build the `Dockerfile`, set the variables above, and route HTTPS to `$PORT` (default 8787). Health check: `GET /healthz`.

## 3. Webhook

In the knowledge repo: Settings, Webhooks, add `<URL>/hooks/github`, content type JSON, secret = `KB_WEBHOOK_SECRET`, push events only. Each merge then refreshes the server within seconds. A cold start always loads the latest `main`, so a missed webhook only matters while an instance stays warm.

## 4. Connect the web apps

| App | Where | URL |
| --- | --- | --- |
| Claude web (also Duet) | Settings, Connectors, add custom connector | `<URL>/mcp/read` first; `/mcp/write` once you want flagging |
| ChatGPT web | Settings, Apps, developer mode, add custom MCP server | same |

Both run the OAuth sign-in; only `KB_ALLOWED_GITHUB_LOGIN` can finish it. Tokens last an hour and refresh for 30 days.

## Endpoints and limits

- `/mcp/read`: `search_knowledge`, `get_concept`, `kb://profile`. Read-only.
- `/mcp/write`: the read tools plus `flag_knowledge`, `ingest` and `add_source`.
- Pages marked `sensitive` are never served here.
- 60 calls a minute and 50 writes a day per client.
- Revoke one client: `KB_REVOKED_CLIENTS=<id>` (ids are in the audit log, which goes to the host's logs).

## Not yet verified

No host has been deployed to yet, and the Docker image has not been built (no Docker daemon in the build environment). The compiled binary has been run against a fake GitHub serving a zipball.
