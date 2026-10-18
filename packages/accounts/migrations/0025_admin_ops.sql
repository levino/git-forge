CREATE TABLE instance_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE storage_objects (
  key TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'lfs')),
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE repository_usage (
  repository TEXT PRIMARY KEY,
  git_bytes INTEGER NOT NULL DEFAULT 0,
  lfs_bytes INTEGER NOT NULL DEFAULT 0,
  objects INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER storage_objects_usage AFTER INSERT ON storage_objects
BEGIN
  INSERT OR IGNORE INTO repository_usage (repository, updated_at) VALUES (NEW.repository, NEW.created_at);
  UPDATE repository_usage
  SET git_bytes = git_bytes + CASE WHEN NEW.kind = 'git' THEN NEW.size ELSE 0 END,
      lfs_bytes = lfs_bytes + CASE WHEN NEW.kind = 'lfs' THEN NEW.size ELSE 0 END,
      objects = objects + 1,
      updated_at = NEW.created_at
  WHERE repository = NEW.repository;
END;
--> statement-breakpoint
CREATE TABLE usage_counters (
  month TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (month, metric)
);
--> statement-breakpoint
CREATE TABLE job_failures (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  sealed_authorization TEXT,
  attempts INTEGER NOT NULL,
  error TEXT NOT NULL,
  final INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX job_failures_updated ON job_failures (updated_at);
