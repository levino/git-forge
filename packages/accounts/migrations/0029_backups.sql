CREATE TABLE backup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  state TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE backup_objects (
  path TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);
