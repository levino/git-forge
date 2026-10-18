CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'organization')),
  login TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT,
  email TEXT,
  default_repository_role TEXT CHECK (default_repository_role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  CHECK (kind = 'organization' OR default_repository_role IS NULL)
);
--> statement-breakpoint
CREATE TABLE external_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  email TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  PRIMARY KEY (issuer, subject)
);
--> statement-breakpoint
CREATE INDEX external_identities_account ON external_identities (account_id);
--> statement-breakpoint
CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES accounts (id),
  user_id TEXT NOT NULL REFERENCES accounts (id),
  role TEXT NOT NULL CHECK (role IN ('member', 'owner')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
--> statement-breakpoint
CREATE INDEX organization_members_user ON organization_members (user_id);
--> statement-breakpoint
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES accounts (id),
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, slug)
);
--> statement-breakpoint
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams (id),
  user_id TEXT NOT NULL REFERENCES accounts (id),
  role TEXT NOT NULL CHECK (role IN ('member', 'maintainer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
--> statement-breakpoint
CREATE INDEX team_members_user ON team_members (user_id);
--> statement-breakpoint
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts (id),
  name TEXT NOT NULL COLLATE NOCASE,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, name)
);
--> statement-breakpoint
CREATE TABLE repository_collaborators (
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  user_id TEXT NOT NULL REFERENCES accounts (id),
  role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, user_id)
);
--> statement-breakpoint
CREATE TABLE repository_teams (
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  team_id TEXT NOT NULL REFERENCES teams (id),
  role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, team_id)
);
--> statement-breakpoint
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts (id),
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
--> statement-breakpoint
CREATE TABLE app_repositories (
  app_id TEXT NOT NULL REFERENCES apps (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, repository_id)
);
--> statement-breakpoint
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'app')),
  account_id TEXT REFERENCES accounts (id),
  app_id TEXT REFERENCES apps (id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  repository_ids TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK ((kind = 'personal' AND account_id IS NOT NULL AND app_id IS NULL) OR (kind = 'app' AND app_id IS NOT NULL AND account_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX tokens_account ON tokens (account_id);
--> statement-breakpoint
CREATE INDEX tokens_app ON tokens (app_id);
--> statement-breakpoint
CREATE TABLE trusted_instances (
  issuer TEXT PRIMARY KEY,
  pinned_thumbprint TEXT,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
--> statement-breakpoint
CREATE TABLE instance_repositories (
  issuer TEXT NOT NULL REFERENCES trusted_instances (issuer),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  role TEXT NOT NULL CHECK (role = 'read'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, repository_id)
);
--> statement-breakpoint
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  repository_id TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX audit_log_repository ON audit_log (repository_id, seq);
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
