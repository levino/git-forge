CREATE TABLE federation_installations (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  scopes TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX federation_installations_account ON federation_installations (account_id);
--> statement-breakpoint
CREATE TABLE federation_installation_repositories (
  installation_id TEXT NOT NULL REFERENCES federation_installations (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  PRIMARY KEY (installation_id, repository_id)
);
--> statement-breakpoint
CREATE TABLE federation_codes (
  code_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES federation_installations (id),
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
--> statement-breakpoint
CREATE TABLE federation_subscriptions (
  installation_id TEXT NOT NULL REFERENCES federation_installations (id),
  repository TEXT NOT NULL COLLATE NOCASE,
  callback TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repository, callback)
);
--> statement-breakpoint
CREATE INDEX federation_subscriptions_repository ON federation_subscriptions (repository);
--> statement-breakpoint
CREATE TABLE federation_requests (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  session_id TEXT,
  upstream TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE federation_connections (
  upstream TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upstream, installation_id)
);
--> statement-breakpoint
CREATE INDEX federation_connections_user ON federation_connections (user_id);
