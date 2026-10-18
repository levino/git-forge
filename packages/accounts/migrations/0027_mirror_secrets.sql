CREATE TABLE mirror_secrets (
  owner TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL COLLATE NOCASE,
  remote TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('token', 'webhook')),
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, repo, remote, kind)
);
