CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uri TEXT,
  redirect_uris TEXT NOT NULL,
  software_id TEXT,
  software_version TEXT,
  request_ip TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  client_id TEXT NOT NULL REFERENCES oauth_clients (id),
  name TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  scopes TEXT NOT NULL,
  repository_ids TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX agent_connections_user ON agent_connections (user_id);
--> statement-breakpoint
CREATE INDEX agent_connections_client ON agent_connections (client_id);
--> statement-breakpoint
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id),
  user_id TEXT NOT NULL REFERENCES accounts (id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  repository_ids TEXT,
  connection_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
--> statement-breakpoint
CREATE INDEX oauth_codes_expiry ON oauth_codes (expires_at);
--> statement-breakpoint
CREATE TABLE agent_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  connection_id TEXT NOT NULL REFERENCES agent_connections (id),
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
--> statement-breakpoint
CREATE INDEX agent_tokens_connection ON agent_tokens (connection_id);
--> statement-breakpoint
CREATE INDEX agent_tokens_expiry ON agent_tokens (expires_at);
--> statement-breakpoint
ALTER TABLE tokens ADD COLUMN connection_id TEXT REFERENCES agent_connections (id);
--> statement-breakpoint
CREATE INDEX tokens_connection ON tokens (connection_id);
