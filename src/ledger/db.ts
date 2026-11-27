import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "../lib/identity.ts";
import { MIGRATIONS } from "./schema.ts";

export type Ledger = Database;

/** Opens (and migrates) the ledger at `<home>/ledger.sqlite`. Pass ":memory:" in tests. */
export function openLedger(home: string): Ledger {
  let path = ":memory:";
  if (home !== ":memory:") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    path = join(home, "ledger.sqlite");
  }
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] ?? "");
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export type RunRow = {
  id: number;
  vendor: string;
  model: string;
  cli_version: string | null;
  session_id: string;
  role: string | null;
  identity_source: string;
  started: string;
  ended: string | null;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  wall_ms: number | null;
};

/**
 * Finds or creates the run for a harness identity. Keyed on (vendor, session_id), so the
 * git hooks, `baton test` and a later headless import of the same session share one row.
 * A known model never gets overwritten by "unknown".
 */
export function ensureRun(db: Ledger, id: Identity, source: string, now: Date): RunRow {
  db.query(
    `INSERT INTO runs (vendor, model, cli_version, session_id, identity_source, started)
     VALUES ($vendor, $model, $cli, $session, $source, $now)
     ON CONFLICT (vendor, session_id) DO UPDATE SET
       model = CASE WHEN excluded.model != 'unknown' THEN excluded.model ELSE runs.model END,
       cli_version = COALESCE(excluded.cli_version, runs.cli_version)`,
  ).run({
    vendor: id.vendor,
    model: id.model,
    cli: id.cli_version,
    session: id.session_id,
    source,
    now: now.toISOString(),
  });
  const row = db
    .query<RunRow, { vendor: string; session: string }>(
      "SELECT * FROM runs WHERE vendor = $vendor AND session_id = $session",
    )
    .get({ vendor: id.vendor, session: id.session_id });
  if (!row) throw new Error("run upsert failed");
  return row;
}

export function getRun(db: Ledger, id: number | null): RunRow | null {
  if (id === null) return null;
  return db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
}

/** "claude-code:claude-opus-5-5", or "unknown" for an unidentified run. */
export function runLabel(run: RunRow | null): string {
  if (!run || run.vendor === "unknown") return "unknown";
  return `${run.vendor}:${run.model}`;
}
