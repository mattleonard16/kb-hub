# kb-hub

One knowledge base for all your AI assistants.

kb-hub pulls what Claude Code, Codex, ChatGPT, Gemini, Claude, Muse, Instinct, Dots and Duet know about you into a private Git repo, has a curator agent clean it up through pull requests you approve, and serves it back to every assistant through MCP and generated files.

```sh
bun install
bun run check                         # verify everything
bun run kb lint ../knowledge          # validate a knowledge repo
```

See [AGENTS.md](AGENTS.md) for the module map, commands and rules.
