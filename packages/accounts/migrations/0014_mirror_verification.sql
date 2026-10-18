CREATE TABLE mirror_attestations (
  repository TEXT NOT NULL COLLATE NOCASE,
  issuer TEXT NOT NULL,
  namespace TEXT NOT NULL,
  checksum TEXT NOT NULL,
  refs INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  alarms INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  deep_check_at INTEGER,
  deep_check_ok INTEGER CHECK (deep_check_ok IN (0, 1)),
  url TEXT,
  token TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (repository, issuer)
);
--> statement-breakpoint
CREATE TABLE ref_checksums (
  repository TEXT NOT NULL COLLATE NOCASE,
  namespace TEXT NOT NULL,
  checksum TEXT NOT NULL,
  refs INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (repository, namespace, checksum)
);
--> statement-breakpoint
CREATE TABLE mirror_spot_checks (
  repository TEXT NOT NULL COLLATE NOCASE,
  issuer TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  samples INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  problems TEXT NOT NULL,
  PRIMARY KEY (repository, issuer)
);
