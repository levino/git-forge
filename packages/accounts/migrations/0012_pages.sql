CREATE TABLE pages_sites (
  repository_id TEXT PRIMARY KEY REFERENCES repositories (id),
  build_type TEXT NOT NULL CHECK (build_type IN ('legacy', 'workflow')),
  source_branch TEXT,
  source_path TEXT NOT NULL DEFAULT '/' CHECK (source_path IN ('/', '/docs')),
  active_deployment_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE pages_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  source TEXT NOT NULL CHECK (source IN ('branch', 'artifact', 'upload')),
  ref TEXT,
  commit_sha TEXT,
  artifact_id TEXT,
  artifact_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'succeed', 'failed', 'cancelled')),
  error TEXT,
  manifest TEXT,
  file_count INTEGER,
  total_bytes INTEGER,
  creator_kind TEXT NOT NULL,
  creator_id TEXT,
  creator_login TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX pages_deployments_repository ON pages_deployments (repository_id, id);
--> statement-breakpoint
CREATE TABLE pages_grants (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  host TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
--> statement-breakpoint
CREATE TABLE pages_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  host TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
