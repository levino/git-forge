CREATE TABLE repository_forks (
  repository_id TEXT PRIMARY KEY REFERENCES repositories (id),
  parent_id TEXT NOT NULL REFERENCES repositories (id),
  root_id TEXT NOT NULL REFERENCES repositories (id),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX repository_forks_parent ON repository_forks (parent_id);
--> statement-breakpoint
CREATE INDEX repository_forks_root ON repository_forks (root_id);
--> statement-breakpoint
ALTER TABLE pull_requests ADD COLUMN head_repository_id TEXT REFERENCES repositories (id);
--> statement-breakpoint
ALTER TABLE pull_requests ADD COLUMN maintainer_can_modify INTEGER NOT NULL DEFAULT 0 CHECK (maintainer_can_modify IN (0, 1));
--> statement-breakpoint
CREATE INDEX pull_requests_head_repository ON pull_requests (head_repository_id, head_ref);
