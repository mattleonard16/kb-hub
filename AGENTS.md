# kb-hub

Personal knowledge hub. It ingests what your AI assistants know (Claude Code, Codex, ChatGPT, Gemini, Claude, Muse, Instinct, Dots, Duet), lets a curator agent turn that into one reviewed Git repo of Markdown, and serves it back to every assistant over MCP and generated files.

This repo is the **code**. The **data** lives in a separate private repo, `knowledge`, pointed to by `KB_KNOWLEDGE_DIR`.

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Install (CI uses `bun install --frozen-lockfile`) |
| `bun run check` | Dependency allowlist, typecheck, lint, tests. **Run before finishing any change.** About 5 seconds. |
| `bun test` | Tests only |
| `bun run kb <command>` | Run the CLI from source (`bun run kb help`) |
| `bun run build` | Single binary at `dist/kb` |

Every CLI command takes `--json` for machine-readable output. Exit codes: 0 ok, 1 validation failed, 2 usage error or not built yet.

## Module map

| Path | Job |
| --- | --- |
| `src/schema/` | zod schemas: concept frontmatter, extraction export, flag. The single definition of "valid". |
| `src/lib/` | Small shared helpers: frontmatter parsing (`Bun.YAML`), secret detection |
| `src/lint/` | `kb lint`: validates a knowledge repo |
| `src/ingest/` | `kb ingest`: parse pasted extraction replies and export ZIPs into `inbox/` |
| `src/index/` | `kb index`: SQLite FTS5 search index built from the knowledge repo |
| `src/mcp/` | MCP server: tools, stdio and HTTP transports |
| `src/compile/` | `kb compile` / `kb sync`: CLAUDE.md, AGENTS.md, skills, paste blocks |
| `src/curator/` | The curator skill (run as a scheduled Claude task, not code) |
| `prompts/extract/` | Versioned extraction prompts, one base plus one tail per tool |
| `test/fixtures/` | Real-shaped inputs. Prefer adding a fixture over mocking. |

## Rules

- **Bun only.** Use built-ins before adding a package: `bun:sqlite`, `Bun.YAML`, `Bun.serve`, `bun test`, `util.parseArgs`, `fetch`.
- **Dependency budget.** Allowed packages are listed in `scripts/check-deps.ts`. Adding one needs a one-line reason there and explicit approval in the PR. Pin exact versions.
- **Never write to a knowledge repo's `knowledge/` or `skills/` from code paths agents can call.** Agents write only to `inbox/`. Only the curator, through a pull request, changes knowledge.
- **Never commit secrets.** `src/lib/secrets.ts` and gitleaks in CI catch the common ones.
- **Tool descriptions are static.** MCP tool names and descriptions live in code and are never generated from knowledge content.
- **`reported_by` comes from the authenticated client**, never from tool input.
- Strict TypeScript; no `any`. Biome formats TS and JSON only (not Markdown, it rewrites frontmatter).
- Keep modules small with one job. Add tests next to the behavior you change.

## Pinned versions

Bun 1.4.4, TypeScript 7.0.2, Biome 2.6.8, zod 4.6.7 (see `package.json`).
