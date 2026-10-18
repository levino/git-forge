CREATE TABLE visibility_rules (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  refs TEXT NOT NULL,
  path TEXT,
  audience TEXT NOT NULL CHECK (audience IN ('public', 'user', 'team', 'instance')),
  subject TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((audience = 'public') = (subject IS NULL))
);
--> statement-breakpoint
CREATE INDEX visibility_rules_repository ON visibility_rules (repository_id);
