CREATE TABLE imported_items (
  node_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  source TEXT NOT NULL,
  url TEXT,
  author TEXT,
  created_at INTEGER NOT NULL,
  assignees TEXT NOT NULL DEFAULT '[]',
  UNIQUE (repository_id, source)
);
--> statement-breakpoint
CREATE TABLE import_etags (
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  url TEXT NOT NULL,
  etag TEXT NOT NULL,
  next TEXT,
  PRIMARY KEY (repository_id, url)
);
