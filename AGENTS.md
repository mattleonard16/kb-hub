# Baton

A neutral desk and scorekeeper for coding agents from different vendors: handoff packets, redlines and an outcome ledger. It never dispatches, runs or controls agents.

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Install (CI uses `bun install --frozen-lockfile`) |
| `bun run check` | Dependency allowlist, typecheck, lint, tests. **Run before finishing any change.** |
| `bun test` | Tests only |
| `bun run baton <command>` | Run the CLI from source (`bun run baton help`) |
| `bun run m0` | M0 check: runs one tiny task with `claude -p` and `codex exec` on your login |
| `bun run build` | Single binary at `dist/baton` |

Every CLI command takes `--json`. Exit codes: 0 ok, 1 validation failed (including a failing `baton test`), 2 usage error.

## Module map

| Path | Job |
| --- | --- |
| `src/cli.ts` | Argument parsing and dispatch (`run()` is what tests drive) |
| `src/lib/` | Context (cwd, ledger home, env, identity, clock), git helpers, identity from harness env, sanitize, secrets |
| `src/ledger/` | `bun:sqlite` schema (append-only migrations) and run upsert keyed on (vendor, session) |
| `src/hooks/` | prepare-commit-msg trailers, post-commit recording, hook install |
| `src/importers/` | `claude -p` json/stream-json and `codex exec --json` parsers |
| `src/packet/` | Packet schema (zod), file format, line diff, `~~strike~~` extraction, store with revisions |
| `src/desk/` | `baton digest` cards; accept and prepare actions |
| `src/commands/` | init, test, import, handoff, lint, status |
| `scripts/` | Dependency allowlist, M0 check |
| `test/fixtures/` | Real `claude -p` output (trimmed) and a hand-written Codex sample |

## Rules

- **Never dispatch.** No code path starts, messages or steers an agent. "Prepare" writes files and prints an instruction for the person.
- **Identity comes from harness signals** (env vars set by Claude Code or Codex, headless JSON, Codex rollout files). Never add a flag or field that lets an agent type its vendor, model or session.
- **`baton accept` is the person's verdict.** It runs only with no harness signal and a terminal attached. A session with no signal and no terminal is recorded as `unknown`, never as the person.
- **Only packets Baton wrote on this machine are handoffs.** A packet tracked by git, or one with no ledger record, is refused by read, edit and lint, and shows on the desk only as an ignored warning.
- **Typed trailers are not identity.** A `Baton-Session` trailer only links a commit to a run Baton already saw from a harness signal.
- **Sanitize before writing** test output and evidence: `src/lib/sanitize.ts` (drop `KEY=VALUE` lines, redact secrets, truncate).
- **Packets are local-only by default** (`.baton/handoffs/` is gitignored by `baton init`).
- **The ledger holds paths, hashes and counts**, never file contents or prompts.
- Hooks never block a commit.
- **Bun only**, dependency budget in `scripts/check-deps.ts`. Pin exact versions. Strict TypeScript, no `any`. Biome formats TS and JSON only.
- No network listener and no model API calls in M0 to M5. OTLP and MCP are an optional M6, after the eval.
- Prefer a real fixture over a mock. Add tests next to the behavior you change.

## Pinned versions

Bun 1.4.4, TypeScript 7.0.2, Biome 2.6.8, zod 4.6.7 (see `package.json`).
