ALTER TABLE apps ADD COLUMN description TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN external_url TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN setup_url TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN redirect_url TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN events TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN client_id TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN client_secret_hash TEXT;
--> statement-breakpoint
ALTER TABLE apps ADD COLUMN updated_at INTEGER;
--> statement-breakpoint
CREATE UNIQUE INDEX apps_client_id ON apps (client_id);
--> statement-breakpoint
CREATE TABLE app_keys (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  public_jwk TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX app_keys_app ON app_keys (app_id);
--> statement-breakpoint
CREATE TABLE app_installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  events TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX app_installations_live ON app_installations (app_id, account_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX app_installations_account ON app_installations (account_id);
--> statement-breakpoint
CREATE TABLE app_installation_repositories (
  installation_id INTEGER NOT NULL REFERENCES app_installations (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repository_id)
);
--> statement-breakpoint
CREATE INDEX app_installation_repositories_repository ON app_installation_repositories (repository_id);
--> statement-breakpoint
CREATE TABLE app_manifest_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
--> statement-breakpoint
ALTER TABLE tokens ADD COLUMN installation_id INTEGER REFERENCES app_installations (id);
--> statement-breakpoint
ALTER TABLE tokens ADD COLUMN permissions TEXT;
--> statement-breakpoint
CREATE TABLE webhooks_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT REFERENCES repositories (id),
  organization_id TEXT REFERENCES accounts (id),
  app_id TEXT REFERENCES apps (id),
  url TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'json' CHECK (content_type IN ('json', 'form')),
  secret TEXT,
  secret_key_id TEXT,
  secret_iv TEXT,
  insecure_ssl INTEGER NOT NULL DEFAULT 0 CHECK (insecure_ssl IN (0, 1)),
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((repository_id IS NOT NULL) + (organization_id IS NOT NULL) + (app_id IS NOT NULL) = 1)
);
--> statement-breakpoint
INSERT INTO webhooks_v2 (id, repository_id, organization_id, url, content_type, secret, insecure_ssl, events, active, created_by, created_at, updated_at)
  SELECT id, repository_id, organization_id, url, content_type, secret, insecure_ssl, events, active, created_by, created_at, updated_at FROM webhooks;
--> statement-breakpoint
DROP TABLE webhooks;
--> statement-breakpoint
ALTER TABLE webhooks_v2 RENAME TO webhooks;
--> statement-breakpoint
CREATE INDEX webhooks_repository ON webhooks (repository_id);
--> statement-breakpoint
CREATE INDEX webhooks_organization ON webhooks (organization_id);
--> statement-breakpoint
CREATE UNIQUE INDEX webhooks_app ON webhooks (app_id);
