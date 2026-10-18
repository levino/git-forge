CREATE TABLE mirror_subscriptions (
  issuer TEXT NOT NULL REFERENCES trusted_instances (issuer),
  repository TEXT NOT NULL COLLATE NOCASE,
  callback TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, repository, callback)
);
--> statement-breakpoint
CREATE INDEX mirror_subscriptions_repository ON mirror_subscriptions (repository);
