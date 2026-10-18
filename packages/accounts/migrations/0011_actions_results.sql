CREATE TABLE actions_blobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  prefix TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE actions_blob_blocks (
  blob_id TEXT NOT NULL REFERENCES actions_blobs(id),
  block_id TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER NOT NULL,
  staged_at INTEGER NOT NULL,
  PRIMARY KEY (blob_id, block_id)
);
--> statement-breakpoint
CREATE TABLE actions_blob_parts (
  blob_id TEXT NOT NULL REFERENCES actions_blobs(id),
  idx INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (blob_id, idx)
);
--> statement-breakpoint
CREATE TABLE actions_blob_grants (
  hash TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL REFERENCES actions_blobs(id),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  job_id TEXT,
  filename TEXT,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX actions_blob_grants_job ON actions_blob_grants (job_id, expires_at);
--> statement-breakpoint
CREATE TABLE actions_caches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES actions_blobs(id),
  job_id TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  last_accessed_at INTEGER NOT NULL,
  evicted_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX actions_caches_entry ON actions_caches (owner, repo, scope, key, version) WHERE evicted_at IS NULL;
--> statement-breakpoint
CREATE INDEX actions_caches_lookup ON actions_caches (owner, repo, version, scope, evicted_at);
--> statement-breakpoint
CREATE INDEX actions_caches_access ON actions_caches (evicted_at, last_accessed_at);
--> statement-breakpoint
CREATE TABLE actions_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES actions_blobs(id),
  version INTEGER NOT NULL,
  mime_type TEXT,
  size INTEGER,
  digest TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  expires_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX actions_artifacts_name ON actions_artifacts (run_id, name) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX actions_artifacts_repo ON actions_artifacts (owner, repo, id);
