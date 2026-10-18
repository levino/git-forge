CREATE TABLE actions_runners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  labels TEXT NOT NULL,
  public_key TEXT NOT NULL,
  ephemeral INTEGER NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE actions_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'runner', 'runtime', 'github')),
  runner_id INTEGER REFERENCES actions_runners(id),
  job_id TEXT,
  owner TEXT,
  repo TEXT,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE actions_sessions (
  id TEXT PRIMARY KEY,
  runner_id INTEGER NOT NULL REFERENCES actions_runners(id),
  owner_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE actions_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  event TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE actions_jobs (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id INTEGER NOT NULL REFERENCES actions_runs(id),
  job_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  labels TEXT NOT NULL,
  definition TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'assigned', 'in_progress', 'completed')),
  needs TEXT NOT NULL,
  conclusion TEXT,
  runner_id INTEGER REFERENCES actions_runners(id),
  session_id TEXT,
  queued_at INTEGER NOT NULL,
  assigned_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  locked_until INTEGER
);
--> statement-breakpoint
CREATE INDEX actions_jobs_status ON actions_jobs (status, request_id);
--> statement-breakpoint
CREATE TABLE actions_timeline_records (
  timeline_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (timeline_id, record_id)
);
--> statement-breakpoint
CREATE TABLE actions_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  path TEXT NOT NULL,
  chunks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
