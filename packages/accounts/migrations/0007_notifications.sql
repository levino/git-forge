CREATE TABLE forge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  action TEXT,
  repository_id TEXT REFERENCES repositories (id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  actor_login TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX forge_events_repository ON forge_events (repository_id, id);
--> statement-breakpoint
CREATE TRIGGER forge_events_no_update BEFORE UPDATE ON forge_events
BEGIN
  SELECT RAISE(ABORT, 'forge_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER forge_events_no_delete BEFORE DELETE ON forge_events
BEGIN
  SELECT RAISE(ABORT, 'forge_events is append-only');
END;
--> statement-breakpoint
CREATE TABLE repository_watches (
  user_id TEXT NOT NULL REFERENCES accounts (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  level TEXT NOT NULL CHECK (level IN ('all', 'releases', 'ignore')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repository_id)
);
--> statement-breakpoint
CREATE INDEX repository_watches_repository ON repository_watches (repository_id, level);
--> statement-breakpoint
CREATE TABLE thread_subscriptions (
  user_id TEXT NOT NULL REFERENCES accounts (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  subject_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repository_id, subject_key)
);
--> statement-breakpoint
CREATE INDEX thread_subscriptions_subject ON thread_subscriptions (repository_id, subject_key);
--> statement-breakpoint
CREATE TABLE notification_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES accounts (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  subject_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  subject_url TEXT,
  latest_comment_url TEXT,
  html_url TEXT,
  reason TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 1 CHECK (unread IN (0, 1)),
  last_event_id INTEGER REFERENCES forge_events (id),
  updated_at INTEGER NOT NULL,
  last_read_at INTEGER,
  emailed_at INTEGER,
  UNIQUE (user_id, repository_id, subject_key)
);
--> statement-breakpoint
CREATE INDEX notification_threads_inbox ON notification_threads (user_id, updated_at);
--> statement-breakpoint
CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES accounts (id),
  email_mode TEXT NOT NULL DEFAULT 'instant' CHECK (email_mode IN ('off', 'instant', 'hourly', 'daily')),
  email_participating INTEGER NOT NULL DEFAULT 1 CHECK (email_participating IN (0, 1)),
  email_watching INTEGER NOT NULL DEFAULT 0 CHECK (email_watching IN (0, 1)),
  own_activity INTEGER NOT NULL DEFAULT 0 CHECK (own_activity IN (0, 1)),
  email_address TEXT,
  digest_due_at INTEGER,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX notification_settings_digest ON notification_settings (digest_due_at);
--> statement-breakpoint
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT REFERENCES repositories (id),
  organization_id TEXT REFERENCES accounts (id),
  url TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'json' CHECK (content_type IN ('json', 'form')),
  secret TEXT,
  insecure_ssl INTEGER NOT NULL DEFAULT 0 CHECK (insecure_ssl IN (0, 1)),
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((repository_id IS NULL) <> (organization_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX webhooks_repository ON webhooks (repository_id);
--> statement-breakpoint
CREATE INDEX webhooks_organization ON webhooks (organization_id);
--> statement-breakpoint
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id INTEGER NOT NULL,
  guid TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  event_id INTEGER,
  repository_id TEXT,
  redelivery INTEGER NOT NULL DEFAULT 0 CHECK (redelivery IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  duration_ms INTEGER,
  error TEXT,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  request_headers TEXT,
  response_headers TEXT,
  response_body TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  next_attempt_at INTEGER
);
--> statement-breakpoint
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (hook_id, id);
--> statement-breakpoint
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (status, next_attempt_at);
--> statement-breakpoint
CREATE TABLE releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  tag_name TEXT NOT NULL,
  target_commitish TEXT NOT NULL,
  name TEXT,
  body TEXT,
  draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
  prerelease INTEGER NOT NULL CHECK (prerelease IN (0, 1)),
  author_kind TEXT NOT NULL,
  author_id TEXT,
  author_login TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (repository_id, tag_name)
);
--> statement-breakpoint
CREATE TABLE release_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL REFERENCES releases (id),
  name TEXT NOT NULL,
  label TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  oid TEXT NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  uploader_kind TEXT NOT NULL,
  uploader_id TEXT,
  uploader_login TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (release_id, name)
);
