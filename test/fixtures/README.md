# Fixtures

- `claude-result.json`, `claude-stream.jsonl`: real `claude -p` output (`--output-format json` and `--output-format stream-json --verbose`), trimmed to the fields Baton reads.
- `codex-exec.synthetic.jsonl`: written by hand from the documented `codex exec --json` event shapes. Replace it with a real capture from `bun run m0 --codex` (M0).
