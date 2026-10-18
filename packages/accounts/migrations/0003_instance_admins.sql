CREATE TABLE instance_admins (
  user_id TEXT PRIMARY KEY REFERENCES accounts (id),
  created_at INTEGER NOT NULL
);
