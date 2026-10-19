CREATE TABLE scim_users (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  user_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX scim_users_external_id ON scim_users (external_id);
