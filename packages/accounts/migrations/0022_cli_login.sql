ALTER TABLE device_authorizations ADD COLUMN client_host TEXT;
--> statement-breakpoint
ALTER TABLE device_authorizations ADD COLUMN request_ip TEXT;
--> statement-breakpoint
CREATE INDEX device_authorizations_expiry ON device_authorizations (expires_at);
--> statement-breakpoint
CREATE TABLE cli_authorizations (
  id_hash TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  client_name TEXT NOT NULL,
  client_host TEXT,
  request_ip TEXT,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  user_id TEXT REFERENCES accounts (id),
  token_id TEXT REFERENCES tokens (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  used_at INTEGER
);
--> statement-breakpoint
CREATE INDEX cli_authorizations_expiry ON cli_authorizations (expires_at);
--> statement-breakpoint
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
--> statement-breakpoint
CREATE INDEX rate_limits_expiry ON rate_limits (expires_at);
