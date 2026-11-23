# Hosted kb-hub MCP server. Build: docker build -t kb-hub .
FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts
RUN bun build src/cli.ts --compile --outfile /app/kb

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 kb
COPY --from=build /app/kb /usr/local/bin/kb
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
USER kb
WORKDIR /home/kb
ENV PORT=8787 KB_KNOWLEDGE_DIR=/home/kb/knowledge KB_STATE_DIR=/home/kb/.kb
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
