CREATE TABLE collaboration_settings (
  repository_id TEXT PRIMARY KEY REFERENCES repositories (id),
  has_issues INTEGER NOT NULL DEFAULT 1 CHECK (has_issues IN (0, 1)),
  has_discussions INTEGER NOT NULL DEFAULT 1 CHECK (has_discussions IN (0, 1)),
  read_can_participate INTEGER NOT NULL DEFAULT 1 CHECK (read_can_participate IN (0, 1)),
  allow_merge_commit INTEGER NOT NULL DEFAULT 1 CHECK (allow_merge_commit IN (0, 1)),
  allow_squash_merge INTEGER NOT NULL DEFAULT 1 CHECK (allow_squash_merge IN (0, 1)),
  allow_rebase_merge INTEGER NOT NULL DEFAULT 1 CHECK (allow_rebase_merge IN (0, 1)),
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE repository_numbers (
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull', 'discussion')),
  node_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (repository_id, number)
);
--> statement-breakpoint
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  due_on INTEGER,
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('user', 'app')),
  creator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (repository_id, number),
  UNIQUE (repository_id, title)
);
--> statement-breakpoint
CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  number INTEGER NOT NULL,
  is_pull INTEGER NOT NULL CHECK (is_pull IN (0, 1)),
  title TEXT NOT NULL,
  body TEXT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'app')),
  author_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  state_reason TEXT CHECK (state_reason IN ('completed', 'not_planned', 'reopened', 'duplicate')),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  lock_reason TEXT,
  milestone_id INTEGER REFERENCES milestones (id),
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by_kind TEXT,
  closed_by_id TEXT,
  UNIQUE (repository_id, number)
);
--> statement-breakpoint
CREATE INDEX issues_listing ON issues (repository_id, is_pull, state, number);
--> statement-breakpoint
CREATE TABLE issue_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'app')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX issue_comments_issue ON issue_comments (issue_id, id);
--> statement-breakpoint
CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (repository_id, name)
);
--> statement-breakpoint
CREATE TABLE issue_labels (
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  label_id INTEGER NOT NULL REFERENCES labels (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, label_id)
);
--> statement-breakpoint
CREATE INDEX issue_labels_label ON issue_labels (label_id);
--> statement-breakpoint
CREATE TABLE issue_assignees (
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  user_id TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);
--> statement-breakpoint
CREATE INDEX issue_assignees_user ON issue_assignees (user_id);
--> statement-breakpoint
CREATE TABLE issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'app', 'system')),
  actor_id TEXT,
  event TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX issue_events_issue ON issue_events (issue_id, id);
--> statement-breakpoint
CREATE TABLE pull_requests (
  issue_id INTEGER PRIMARY KEY REFERENCES issues (id),
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  head_ref TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  last_pusher_kind TEXT,
  last_pusher_id TEXT,
  merged_at INTEGER,
  merged_by_kind TEXT,
  merged_by_id TEXT,
  merge_commit_sha TEXT,
  merge_method TEXT CHECK (merge_method IN ('merge', 'squash', 'rebase')),
  check_key TEXT,
  check_result TEXT
);
--> statement-breakpoint
CREATE INDEX pull_requests_head ON pull_requests (repository_id, head_ref);
--> statement-breakpoint
CREATE INDEX pull_requests_base ON pull_requests (repository_id, base_ref);
--> statement-breakpoint
CREATE TABLE review_requests (
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  user_id TEXT NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);
--> statement-breakpoint
CREATE TABLE pull_request_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'app')),
  author_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED')),
  body TEXT,
  commit_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  dismissed_at INTEGER,
  dismissed_by_kind TEXT,
  dismissed_by_id TEXT,
  dismissal_message TEXT
);
--> statement-breakpoint
CREATE INDEX pull_request_reviews_issue ON pull_request_reviews (issue_id, id);
--> statement-breakpoint
CREATE TABLE review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  issue_id INTEGER NOT NULL REFERENCES issues (id),
  review_id INTEGER NOT NULL REFERENCES pull_request_reviews (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'app')),
  author_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
  start_line INTEGER,
  start_side TEXT CHECK (start_side IN ('LEFT', 'RIGHT')),
  in_reply_to_id INTEGER REFERENCES review_comments (id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX review_comments_issue ON review_comments (issue_id, id);
--> statement-breakpoint
CREATE TABLE commit_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  sha TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('error', 'failure', 'pending', 'success')),
  target_url TEXT,
  description TEXT,
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('user', 'app', 'system')),
  creator_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX commit_statuses_sha ON commit_statuses (repository_id, sha, id);
--> statement-breakpoint
CREATE TABLE check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending')),
  conclusion TEXT CHECK (conclusion IN ('action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'timed_out')),
  external_id TEXT,
  details_url TEXT,
  output_title TEXT,
  output_summary TEXT,
  output_text TEXT,
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('user', 'app', 'system')),
  creator_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX check_runs_sha ON check_runs (repository_id, head_sha, id);
--> statement-breakpoint
CREATE TABLE discussion_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  answerable INTEGER NOT NULL DEFAULT 0 CHECK (answerable IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (repository_id, slug)
);
--> statement-breakpoint
CREATE TABLE discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL REFERENCES repositories (id),
  number INTEGER NOT NULL,
  category_id INTEGER NOT NULL REFERENCES discussion_categories (id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'app')),
  author_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  state_reason TEXT CHECK (state_reason IN ('resolved', 'outdated', 'duplicate', 'reopened')),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  answer_comment_id INTEGER,
  answer_chosen_at INTEGER,
  answer_chosen_by_kind TEXT,
  answer_chosen_by_id TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (repository_id, number)
);
--> statement-breakpoint
CREATE INDEX discussions_category ON discussions (repository_id, category_id, number);
--> statement-breakpoint
CREATE TABLE discussion_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  discussion_id INTEGER NOT NULL REFERENCES discussions (id),
  parent_id INTEGER REFERENCES discussion_comments (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'app')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
--> statement-breakpoint
CREATE INDEX discussion_comments_discussion ON discussion_comments (discussion_id, id);
