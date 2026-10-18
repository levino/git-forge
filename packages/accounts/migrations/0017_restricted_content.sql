CREATE TABLE restriction_rules (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  pattern TEXT,
  oid TEXT,
  role TEXT NOT NULL CHECK (role IN ('triage', 'write', 'maintain', 'admin')),
  note TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((pattern IS NULL) <> (oid IS NULL))
);
--> statement-breakpoint
CREATE INDEX restriction_rules_repository ON restriction_rules (repository_id);
--> statement-breakpoint
CREATE TABLE restricted_objects (
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  oid TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES restriction_rules (id),
  path TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, oid, rule_id)
);
