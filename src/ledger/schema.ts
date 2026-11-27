/**
 * The outcome ledger's tables. Each entry in MIGRATIONS runs once, in order,
 * tracked by SQLite's user_version. Never edit a shipped migration; append a new one.
 *
 * The ledger holds paths, hashes, counts and short sanitized notes. Never file contents or prompts.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    vendor TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'unknown',
    cli_version TEXT,
    session_id TEXT NOT NULL,
    task_id TEXT,
    role TEXT CHECK (role IN ('author', 'reviewer', 'receiver')),
    identity_source TEXT NOT NULL,
    started TEXT NOT NULL,
    ended TEXT,
    turns INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    wall_ms INTEGER,
    UNIQUE (vendor, session_id)
  );

  CREATE TABLE reads (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT,
    source TEXT NOT NULL CHECK (source IN ('json-events', 'git', 'inferred')),
    UNIQUE (run_id, repo, path, source)
  );

  CREATE TABLE writes (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT,
    source TEXT NOT NULL CHECK (source IN ('json-events', 'git', 'inferred')),
    UNIQUE (run_id, repo, path, source)
  );

  CREATE TABLE commits (
    sha TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    run_id INTEGER REFERENCES runs(id),
    diff_hash TEXT NOT NULL,
    files INTEGER NOT NULL,
    subject TEXT NOT NULL,
    committed TEXT NOT NULL
  );

  CREATE TABLE test_results (
    id INTEGER PRIMARY KEY,
    repo TEXT NOT NULL,
    run_id INTEGER REFERENCES runs(id),
    "commit" TEXT,
    dirty INTEGER NOT NULL,
    cmd TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    suite_hash TEXT NOT NULL,
    output_tail TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    recorded TEXT NOT NULL
  );

  CREATE TABLE handoffs (
    id TEXT NOT NULL,
    repo TEXT NOT NULL,
    from_run INTEGER REFERENCES runs(id),
    to_run INTEGER REFERENCES runs(id),
    packet_path TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'baton-packet-v1',
    created TEXT NOT NULL,
    PRIMARY KEY (repo, id)
  );

  CREATE TABLE packet_revisions (
    repo TEXT NOT NULL,
    handoff_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    author TEXT NOT NULL,
    run_id INTEGER REFERENCES runs(id),
    diff TEXT NOT NULL,
    struck INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    PRIMARY KEY (repo, handoff_id, rev)
  );

  CREATE TABLE findings (
    id INTEGER PRIMARY KEY,
    repo TEXT NOT NULL,
    review_run_id INTEGER REFERENCES runs(id),
    "commit" TEXT NOT NULL,
    file TEXT,
    line INTEGER,
    claim TEXT NOT NULL,
    test_result_id INTEGER REFERENCES test_results(id),
    verdict TEXT NOT NULL DEFAULT 'pending' CHECK (verdict IN ('confirmed', 'rejected', 'pending')),
    evidence TEXT
  );

  CREATE TABLE verdicts (
    id INTEGER PRIMARY KEY,
    repo TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('commit', 'handoff')),
    target TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    note TEXT,
    recorded TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('bug-fix', 'feature', 'refactor', 'tests')),
    source TEXT,
    hidden_test TEXT
  );

  CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    repo TEXT NOT NULL,
    paths TEXT NOT NULL,
    run_id INTEGER REFERENCES runs(id),
    lease_until TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'baton' CHECK (source IN ('baton', 'beads', 'agent_mail'))
  );

  CREATE INDEX test_results_repo ON test_results (repo, recorded);
  CREATE INDEX commits_repo ON commits (repo, committed);
  `,
];
