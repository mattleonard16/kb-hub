# Baton

A shift-change desk and scorekeeper for coding agents from different vendors (Claude Code, Codex).

You coordinate agents by triaging and editing shared artifacts, not by retyping context into chat windows:

- **Handoff packets** let any agent pick up another agent's work without you re-explaining it.
- **Redline-as-Prompt:** you edit the packet (`~~strike~~` an approach, tighten acceptance criteria), and the saved diff is what the next agent reads first.
- **An outcome ledger** records what each agent wrote, tested and handed off, graded by real test runs, so you can later see which agent or pairing actually works.

**Baton is not an orchestrator.** It never starts, messages or steers an agent. "Prepare" actions write local files and print one line for you to give an agent in its own tool.

Spec: the Baton MVP spec in the project files. This repo is at milestones M0 to M2.

## Quick start

```sh
bun install --frozen-lockfile        # needs Bun 1.4.4+; an older Bun fails here instead of rewriting bun.lock
bun run check                        # deps allowlist, typecheck, lint, tests
cd ~/code/your-repo
bun ~/code/kb-hub/src/cli.ts init    # .baton/, .gitignore, git hooks, AGENTS.md/CLAUDE.md section
alias baton="bun ~/code/kb-hub/src/cli.ts"   # or: bun run build, then put dist/baton on PATH
```

Then, day to day:

| You (the person) | Agents |
| --- | --- |
| `baton digest`: the desk, with failing tests, commits, claims and waiting handoffs | `baton digest --json` at session start |
| `baton accept c-1a2b3c4` / `baton accept h-2` | `baton test -- bun test` |
| `baton prepare handoff`, then `baton handoff edit h-3` to fill and redline it | `baton handoff create --goal ... --acceptance ... --next ... --observation ...` |
| `baton prepare review <commit>` | `baton handoff read h-3` |

Commits by an agent get `Assisted-by` and `Baton-Session` trailers from the git hook. To fill in model and token counts for headless runs:

```sh
claude -p "..." --output-format stream-json --verbose > run.jsonl && baton import claude run.jsonl
codex exec --json "..." > run.jsonl && baton import codex run.jsonl
```

## M0: check your own logins

```sh
bun run m0            # sign in to claude and codex first; runs one tiny task with each CLI found on PATH
```

It checks that headless JSON reports session, model, tokens, turns and tool events, and that the agent's own commit lands in the ledger under the same session. Raw outputs go to `m0-results/` (gitignored).

## Where things live

- `.baton/handoffs/` in each repo: packets and their revision history. **Gitignored by default.** Baton only serves packets it wrote on this machine, so a packet committed to git (say, in someone else's branch) is refused, whatever it claims.
- `~/.baton/ledger.sqlite` (or `$BATON_HOME`): the personal ledger. Paths, hashes, counts and short sanitized test notes. Never file contents or prompts.

See [AGENTS.md](AGENTS.md) for the module map and rules.
