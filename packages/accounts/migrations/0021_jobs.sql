CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX jobs_due ON jobs (queue, run_at);
