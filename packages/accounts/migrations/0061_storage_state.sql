CREATE TABLE storage_state (
  key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  token TEXT,
  pending_at INTEGER,
  cached INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  body TEXT
);
