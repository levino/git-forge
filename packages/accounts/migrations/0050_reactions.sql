CREATE TABLE reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue', 'issue_comment', 'review_comment')),
  subject_id INTEGER NOT NULL,
  user_kind TEXT NOT NULL CHECK (user_kind IN ('user', 'app')),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (content IN ('+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes')),
  created_at INTEGER NOT NULL,
  UNIQUE (subject_kind, subject_id, user_kind, user_id, content)
);
