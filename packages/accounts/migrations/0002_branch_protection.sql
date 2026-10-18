CREATE TABLE branch_protection_rules (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  pattern TEXT NOT NULL,
  allow_force_pushes INTEGER NOT NULL DEFAULT 0 CHECK (allow_force_pushes IN (0, 1)),
  allow_deletions INTEGER NOT NULL DEFAULT 0 CHECK (allow_deletions IN (0, 1)),
  enforce_admins INTEGER NOT NULL DEFAULT 0 CHECK (enforce_admins IN (0, 1)),
  restrict_pushes INTEGER NOT NULL DEFAULT 0 CHECK (restrict_pushes IN (0, 1)),
  require_pull_request INTEGER NOT NULL DEFAULT 0 CHECK (require_pull_request IN (0, 1)),
  required_approving_review_count INTEGER NOT NULL DEFAULT 0 CHECK (required_approving_review_count BETWEEN 0 AND 6),
  dismiss_stale_reviews INTEGER NOT NULL DEFAULT 0 CHECK (dismiss_stale_reviews IN (0, 1)),
  require_code_owner_reviews INTEGER NOT NULL DEFAULT 0 CHECK (require_code_owner_reviews IN (0, 1)),
  require_last_push_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_last_push_approval IN (0, 1)),
  require_status_checks INTEGER NOT NULL DEFAULT 0 CHECK (require_status_checks IN (0, 1)),
  strict_status_checks INTEGER NOT NULL DEFAULT 0 CHECK (strict_status_checks IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repository_id, pattern)
);
--> statement-breakpoint
CREATE TABLE branch_protection_push_allowances (
  rule_id TEXT NOT NULL REFERENCES branch_protection_rules (id),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'team', 'app', 'role')),
  subject TEXT NOT NULL,
  PRIMARY KEY (rule_id, kind, subject),
  CHECK (kind <> 'role' OR subject IN ('read', 'triage', 'write', 'maintain', 'admin'))
);
--> statement-breakpoint
CREATE TABLE branch_protection_status_checks (
  rule_id TEXT NOT NULL REFERENCES branch_protection_rules (id),
  context TEXT NOT NULL,
  PRIMARY KEY (rule_id, context)
);
