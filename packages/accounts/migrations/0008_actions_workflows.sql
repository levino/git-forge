ALTER TABLE actions_runs ADD COLUMN definition TEXT;
--> statement-breakpoint
ALTER TABLE actions_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE actions_runs ADD COLUMN trusted INTEGER NOT NULL DEFAULT 1 CHECK (trusted IN (0, 1));
--> statement-breakpoint
ALTER TABLE actions_runs ADD COLUMN concurrency_group TEXT;
--> statement-breakpoint
ALTER TABLE actions_runs ADD COLUMN cancelled_at INTEGER;
--> statement-breakpoint
ALTER TABLE actions_runs ADD COLUMN completed_at INTEGER;
--> statement-breakpoint
ALTER TABLE actions_runs ADD COLUMN conclusion TEXT;
--> statement-breakpoint
CREATE INDEX actions_runs_concurrency ON actions_runs (owner, repo, concurrency_group, completed_at);
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN expanded INTEGER NOT NULL DEFAULT 1 CHECK (expanded IN (0, 1));
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN matrix TEXT;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN outputs TEXT;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN environment TEXT;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN approval TEXT CHECK (approval IS NULL OR approval IN ('waiting', 'approved', 'rejected'));
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN reviewed_by TEXT;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN message_acked_at INTEGER;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN cancel_requested_at INTEGER;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN cancel_reason TEXT;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN cancel_delivered_at INTEGER;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN launches INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE actions_jobs ADD COLUMN check_run_id INTEGER;
--> statement-breakpoint
CREATE INDEX actions_jobs_run ON actions_jobs (run_id, job_key, attempt);
--> statement-breakpoint
CREATE INDEX actions_jobs_session ON actions_jobs (session_id, status);
--> statement-breakpoint
CREATE TABLE actions_secrets (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, environment, name)
);
--> statement-breakpoint
CREATE TABLE actions_environments (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  reviewers TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, name)
);
--> statement-breakpoint
CREATE TABLE actions_schedules (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  cron TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, workflow_path, cron)
);
--> statement-breakpoint
CREATE INDEX actions_schedules_due ON actions_schedules (next_run_at);
--> statement-breakpoint
CREATE TABLE check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  app TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale')),
  external_id TEXT,
  details_url TEXT,
  title TEXT,
  summary TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX check_runs_commit ON check_runs (owner, repo, head_sha, name);
