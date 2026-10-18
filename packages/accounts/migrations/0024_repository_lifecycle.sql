ALTER TABLE repositories ADD COLUMN storage_path TEXT;
--> statement-breakpoint
UPDATE repositories SET storage_path = (SELECT login FROM accounts WHERE accounts.id = repositories.owner_id) || '/' || name;
--> statement-breakpoint
CREATE INDEX repositories_storage_path ON repositories (storage_path);
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN description TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN homepage TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN archived_at INTEGER;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN deleted_at INTEGER;
--> statement-breakpoint
CREATE TABLE repository_redirects (
  owner TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL COLLATE NOCASE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, name)
);
--> statement-breakpoint
CREATE INDEX repository_redirects_repository ON repository_redirects (repository_id);
--> statement-breakpoint
CREATE TABLE account_redirects (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL
);
