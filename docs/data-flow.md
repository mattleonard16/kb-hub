# How data flows

```
 assistant memory          inbox/ (untrusted)        knowledge/ (reviewed)        assistants
 ────────────────          ──────────────────        ─────────────────────        ──────────
 kb prompt <tool>  ──►     kb ingest  ──► *.yaml ─┐
 data export ZIP   ──►     kb ingest --zip ──►    │   curator (Claude task)
 agent flags (MCP) ──►     flag_knowledge ──►     ├─► PR "Curate: <date>" ──► you add `approve`
 hosted flags      ──►     inbox branch (API) ──► ┘        │                        │
                                                            ▼                        ▼
                                                  drafts in knowledge/      promote: stable + verified
                                                                                     │
                                       ┌─────────────────────────────────────────────┤
                                       ▼                         ▼                   ▼
                              MCP search/get            build/ CLAUDE.md,      kb sync / kb paste
                              (stdio or hosted)         AGENTS.md, paste       (~/.claude, ~/.codex,
                                                                                ChatGPT, Gemini, …)
```

| Stage | Command | Writes | Trust |
| --- | --- | --- | --- |
| Extract | `kb prompt <tool>`, paste into the app | nothing | |
| Ingest | `kb ingest`, `flag_knowledge`, `ingest` (MCP) | `inbox/` only | untrusted; secrets refused, injection marked |
| Curate | the `kb-curator` skill | a `curate/<date>` branch: drafts in `knowledge/`, `skills/`, `log.md`, `inbox/processed/` | agent, unverified |
| Approve | `approve` label (runs `kb promote`, `kb compile`) | `status: stable`, `verified: human:<you>`, `build/` | you |
| Serve | `kb serve`, `kb serve --http` | audit log | drafts are marked `verified: false`; sensitive never hosted |
| Deliver | `kb sync`, `kb paste <tool>` | marked section of `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, kb-managed skills | only global, stable, high-confidence, human-verified, non-sensitive concepts |

The first paragraph of a concept's body is what assistants receive in compiled files, so it should state the whole fact. The `description` is the search summary and the fallback when the body is too long for a line.

`test/e2e.test.ts` runs this whole loop on a fresh repo.

## Test it with your own knowledge

Local only, no hosting needed. Each step has a check.

1. **Create the repo.** `bun run kb init ../knowledge`, push it private (see `setup.md`). Check: `kb lint` says `0 concepts, 1 skills`.
2. **Extract from two tools that overlap**, such as Claude Code and Claude. Run `kb prompt claude-code`, paste the reply into `kb ingest - --tool claude-code`, then do the same for `claude`. Check: `kb inbox` lists two files, and pasting the same reply again says "Already stored".
3. **Run the curator** in a Claude project thread with both repos attached. Check that the PR:
   - has one concept per item
   - merges duplicates across tools into one concept with two sources
   - lists rejections
   - passes `kb lint`
4. **Approve.** Add the `approve` label. Check: the workflow commits `status: stable`, `verified`, and `build/`. Then merge.
5. **Ask questions.** Run `kb search "which runtime should I use"`, or connect `kb serve` to Claude Code and ask it something only your knowledge base knows. Check: the right concept comes first and shows `verified: true`.
6. **Flag a gap** from Claude Code ("the knowledge base has nothing on X"). Check: a file appears in `inbox/flags/`, and the next curator run turns it into a low-confidence draft.
7. **Deliver.** Run `kb sync --dry-run`, then `kb sync`, then `kb paste chatgpt`. Check: your own notes in `~/.claude/CLAUDE.md` are untouched, and `kb status` shows Claude Code and Codex up to date.
