# kb-hub

One knowledge base for all your AI assistants.

kb-hub pulls what Claude Code, Codex, ChatGPT, Gemini, Claude, Muse, Instinct, Dots and Duet know about you into a private Git repo, has a curator agent clean it up through pull requests you approve, and serves it back to every assistant through MCP and generated files.

```sh
bun install
bun run check                         # verify everything
bun run kb lint ../knowledge          # validate a knowledge repo
```

- [Local setup](docs/setup.md): create your knowledge repo, ingest from each assistant, connect Claude Code and Codex.
- [Hosted server](docs/deploy.md): OAuth-protected MCP for Claude web, Duet and ChatGPT.
- [AGENTS.md](AGENTS.md): module map, commands and rules for agents working on this repo.
