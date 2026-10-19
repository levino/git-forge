ALTER TABLE releases ADD COLUMN make_latest TEXT CHECK (make_latest IN ('true', 'false', 'legacy'));
--> statement-breakpoint
ALTER TABLE releases ADD COLUMN latest_at INTEGER;
