# Setup (local)

About 15 minutes. Everything here runs on your machine and uses no API keys.

## 1. Install and create your knowledge repo

```sh
git clone https://github.com/mattleonard16/kb-hub && cd kb-hub
bun install
bun run kb init ../knowledge          # creates the private knowledge repo from the template
cd ../knowledge && git init -b main && git add -A && git commit -m "Start knowledge base"
gh repo create knowledge --private --source . --push
git checkout -b inbox && git push -u origin inbox && git checkout main   # hosted flags land here
```

Set `KB_KNOWLEDGE_DIR` to that folder (or pass `--dir`).

In the knowledge repo's GitHub settings: protect `main` with "Require a pull request before merging" and **0 required approvals** (you can't approve your own PRs; the `approve` label is the approval). Create a label named `approve`.

## 2. Get knowledge in

For each assistant:

```sh
bun run kb prompt chatgpt        # copy, paste into ChatGPT, copy the reply
pbpaste | bun run kb ingest - --tool chatgpt
```

Tools: `claude-code`, `codex`, `chatgpt`, `gemini`, `claude`, `muse`, `instinct`, `dots` (one run per dot), `duet`.

Data exports: `bun run kb ingest --zip ~/Downloads/chatgpt-export.zip --tool chatgpt`.

## 3. Run the curator

In a Claude project thread with both repos attached, ask: "Run the kb-curator skill from kb-hub/src/curator/SKILL.md on the knowledge repo." It opens a `curate/YYYY-MM-DD` PR. Review it, add the `approve` label, then merge.

To make it nightly, ask in the project for a scheduled task at 2 AM Eastern with the same instruction. It runs on your Claude plan.

## 4. Connect Claude Code and Codex (local MCP)

```sh
claude mcp add kb-hub --scope user -- bun /path/to/kb-hub/src/cli.ts serve --dir /path/to/knowledge
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.kb-hub]
command = "bun"
args = ["/path/to/kb-hub/src/cli.ts", "serve", "--dir", "/path/to/knowledge"]
```

## 5. Deliver the profile

```sh
bun run kb sync              # writes the marked section in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md, copies skills
bun run kb paste gemini      # prints the block to paste into Gemini (also: chatgpt, claude, muse, instinct)
bun run kb status            # how many changes behind each tool is
```

## Controls

```sh
bun run kb audit             # what each client read or wrote this week
bun run kb lockdown read-only   # or closed, or off
bun run kb revoke <client-id>
```
