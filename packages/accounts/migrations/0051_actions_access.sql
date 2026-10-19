CREATE TABLE actions_access (
  owner TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL COLLATE NOCASE,
  access_level TEXT NOT NULL CHECK (access_level IN ('none', 'user', 'organization')),
  PRIMARY KEY (owner, repo)
);
--> statement-breakpoint
ALTER TABLE actions_tokens ADD COLUMN scope TEXT;
