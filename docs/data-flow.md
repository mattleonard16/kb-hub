# How data flows

The knowledge repo is an [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). It has three layers: immutable raw sources, a wiki that an agent maintains, and a schema file (`AGENTS.md`). In front of them sits a review queue, so nothing reaches the wiki without your approval.

```
 any source                 inbox/ (queue)             raw/ (kept forever)     wiki/ (reviewed pages)
 ──────────                 ──────────────             ───────────────────     ──────────────────────
 kb add (email, transcript,  ──► sources/ ─┐
   notes, repo, terminal,                  │
   Slack, article)                         │   curator (nightly Claude task)
 add_source (MCP, any agent) ──► sources/  ├─► reads, writes pages ─────────────► PR "Curate: <date>"
 kb prompt + kb ingest       ──► *.yaml    │   kb inbox done ──► raw/<same path>        │
   (each AI assistant)                     │   kb index, kb lint, log.md                │ you add `approve`
 flag_knowledge (MCP)        ──► flags/   ─┘                                            ▼
 connectors in the curator task: Gmail label `kb`, Drive folder `kb-inbox`,    promote: stable + verified,
   Slack, repos                                                                  index + build/ regenerated
                                                                                        │
                           ┌────────────────────────────────────────────────────────────┤
                           ▼                               ▼                            ▼
                  MCP search / get_concept        build/ CLAUDE.md, AGENTS.md,   kb sync / kb paste
                  (links + backlinks; stdio       paste blocks (profile facts    (~/.claude, ~/.codex,
                  or hosted)                      only)                          ChatGPT, Gemini, …)
```

| Stage | Command | Writes | Trust |
| --- | --- | --- | --- |
| Queue | `kb add`, `kb scan`, `kb ingest`, `add_source`, `ingest`, `flag_knowledge` | `inbox/` only | Untrusted. Secrets are refused, and instruction-like text is marked. |
| Ingest | the `kb-curator` skill | A `curate/<date>` branch with draft pages in `wiki/`, skills, and log entries. `kb inbox done` moves the queue to `raw/`. | Agent, unverified |
| Lint | `kb lint`, `kb stale`, `kb index` | `wiki/index.md`, log entries | Checked by code, plus the curator's judgment on contradictions |
| Approve | the `approve` label, which runs `kb promote`, `kb index` and `kb compile` | `status: stable`, `verified: human:<you>`, `build/`, a `promote` log entry | You |
| Query | `kb serve`, `kb serve --http` | Audit log | Drafts show as `verified: false`. Sensitive pages are never hosted. |
| Deliver | `kb sync`, `kb paste <tool>` | The marked section of `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, plus kb-managed skills | Only global, stable, high-confidence, human-verified, non-sensitive profile pages |

## Every kind of knowledge, one wiki

Raw data, code layout, feature maps and existing knowledge bases all go through the same queue into the same wiki, with one schema and one link graph. Each kind gets its own page types. Pages about code also say where their truth lives (`repo`, `resource`, `commit`), so they can be checked against it later.

| Knowledge | How it comes in | What it becomes |
| --- | --- | --- |
| Raw data: email, transcripts, Slack, chats, terminal sessions | `kb add`, `add_source`, the curator's connectors. Kept as-is in `raw/` | A `sources/` summary, plus updates to the project, person, topic and profile pages it informs |
| Code layout | `kb scan <checkout> --name <repo>`: folders, packages, agent instructions and a docs catalog at one commit. No code is copied. | `repos/<repo>` and `modules/<repo>-*` pages that point at paths in the repo |
| Feature maps | The scan plus the code the curator reads in the checkout | `features/<repo>-*`, linked to the project, modules, decisions and people |
| Existing knowledge bases: OKF bundles, ADRs, solutions docs, glossaries | Listed in the scan's docs catalog with their type, title and description | `decisions/`, `lessons/`, `modules/` and `topics/` pages that summarize and link back. The original stays the authority. |

A big repo takes several curator runs: each one files at most 25 pages per repo, and `kb coverage <repo>` lists the docs in the latest scan that no page covers yet, so the next run knows where to pick up. When a repo moves on, `kb stale --repo <repo>=<checkout>` lists the pages whose path changed since their `commit`, and the next curator run refreshes them. Search puts pages that match more of the question first, and a path (`apps/web/src/lib/ai`) finds the page whose `resource` is that path or the closest folder above it. `search_knowledge` filters by `type` and `scope`, so an agent can ask for one repo's features or only the owner's preferences. Lessons are found by their `symptoms`, and code pages by their path.

Rules the code enforces:

- **`raw/` is write-once.** `kb inbox done` refuses to overwrite a raw file, and the knowledge repo's PR check fails if a PR changes or deletes one.
- **Every wiki page except a single profile fact should be linked from another page.** `kb lint` warns on orphans and fails on broken links.
- **A `source` page must cite the raw file it summarizes.**
- **`repo` and `module` pages name their repo, and a `module` names its path in it.** With `repo` set, `resource` must be a path inside the repo.
- **The index is generated by `kb index`, never edited by hand.** `kb lint` warns when it drifts.
- **The log is append-only.** Each entry looks like `## [YYYY-MM-DD] ingest | Title`.

`test/e2e.test.ts` runs the whole loop on a fresh repo.

## Test it with your own knowledge

All of this runs locally; no hosting is needed. Each step ends with a check.

1. **Create the repo.** Run `bun run kb init ../knowledge` and push it as a private repo (see `setup.md`).
   - Check: `kb lint` says `0 concepts, 1 skills`.
2. **Queue a mix of sources.** Use two AI assistants that overlap (`kb prompt claude-code`, then `kb ingest - --tool claude-code`, and the same for `claude`), plus a real email or meeting transcript (`kb add notes.md --kind transcript --title "Planning call"`).
   - Map a code repo too: `kb scan ../my-app --name my-app --exclude docs/customers`. Run it with `--dry-run` first to read what would be queued.
   - Check: `kb inbox` lists them all.
   - Check: adding the same file again says "Already queued".
3. **Run the curator** in a Claude project thread with both repos attached. Check that the PR:
   - writes one summary page per source;
   - updates the project and person pages each source touches;
   - merges duplicates across tools into one page with two sources;
   - links pages with `[[...]]`;
   - files the repo scan as a `repos/` page plus `modules/`, `decisions/` and `lessons/` pages, each with `repo`, `resource` and `commit`, and no copied code;
   - passes `kb lint`.
4. **Approve.** Add the `approve` label.
   - Check: the workflow commits `status: stable`, `verified`, `wiki/index.md` and `build/`.
   - Then merge.
5. **Browse it.** Open the repo in Obsidian.
   - Check: the graph view connects sources, projects and topics.
6. **Ask questions.** Connect `kb serve` to Claude Code and ask something only your wiki knows.
   - Check: the right page comes first, shows `verified: true`, and its backlinks lead to the source.
7. **Feed it back.** Ask Claude Code to save a good answer (it calls `add_source` with kind `answer`), and to flag a gap.
   - Check: both land in `inbox/`, and the next curator run files them.
8. **Deliver.** Run `kb sync --dry-run`, then `kb sync`, then `kb paste chatgpt`.
   - Check: your own notes in `~/.claude/CLAUDE.md` are untouched.
   - Check: `kb status` shows Claude Code and Codex up to date.
