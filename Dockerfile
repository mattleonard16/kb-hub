# Hosted kb-hub MCP server. Build: docker build -t kb-hub .
# Runs on any container host (Cloud Run, Fly, Railway). It needs no git and no disk: the knowledge
# repo is fetched as a zipball into /tmp on start and on each webhook.
FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts
RUN bun build src/cli.ts --compile --outfile /app/kb

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 kb
COPY --from=build /app/kb /usr/local/bin/kb
USER kb
WORKDIR /home/kb
ENV PORT=8787 KB_KNOWLEDGE_DIR=/tmp/kb-knowledge KB_STATE_DIR=/tmp/kb-state
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/kb", "serve", "--http"]
