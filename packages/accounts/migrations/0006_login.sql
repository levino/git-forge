CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  method TEXT NOT NULL CHECK (method IN ('oidc', 'passkey', 'break-glass')),
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX sessions_user ON sessions (user_id);
--> statement-breakpoint
CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  user_handle TEXT NOT NULL,
  algorithm INTEGER NOT NULL CHECK (algorithm IN (-7, -8, -257)),
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  aaguid TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backup_eligible IN (0, 1)),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX webauthn_credentials_user ON webauthn_credentials (user_id);
--> statement-breakpoint
CREATE TABLE login_challenges (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oidc', 'passkey-register', 'passkey-login', 'break-glass')),
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
--> statement-breakpoint
CREATE INDEX login_challenges_expiry ON login_challenges (expires_at);
--> statement-breakpoint
CREATE TABLE device_authorizations (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id TEXT REFERENCES accounts (id),
  token_id TEXT REFERENCES tokens (id),
  interval_seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  decided_at INTEGER
);
--> statement-breakpoint
CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY,
  login TEXT COLLATE NOCASE,
  user_id TEXT REFERENCES accounts (id),
  email TEXT,
  created_by TEXT REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  CHECK (login IS NULL OR user_id IS NULL)
);
