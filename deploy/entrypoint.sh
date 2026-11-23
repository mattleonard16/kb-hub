#!/bin/sh
# Clone the private knowledge repo (read-only token), then serve. The webhook pulls on each merge.
set -eu
: "${KB_GITHUB_REPO:?set KB_GITHUB_REPO (owner/knowledge)}"
: "${KB_GITHUB_READ_TOKEN:?set KB_GITHUB_READ_TOKEN (fine-grained, contents: read)}"
if [ ! -d "$KB_KNOWLEDGE_DIR/.git" ]; then
  git clone --depth 1 --quiet "https://x-access-token:${KB_GITHUB_READ_TOKEN}@github.com/${KB_GITHUB_REPO}.git" "$KB_KNOWLEDGE_DIR"
fi
exec kb serve --http --dir "$KB_KNOWLEDGE_DIR"
