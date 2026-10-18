ALTER TABLE repositories ADD COLUMN default_branch TEXT;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN last_commit_at INTEGER;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN stats_at INTEGER;
--> statement-breakpoint
CREATE INDEX repositories_last_commit ON repositories (last_commit_at);
--> statement-breakpoint
CREATE VIRTUAL TABLE search_repositories USING fts5(repository_id UNINDEXED, owner, name, description, topics);
--> statement-breakpoint
INSERT INTO search_repositories (repository_id, owner, name, description, topics)
SELECT r.id, a.login, r.name, '', '' FROM repositories r JOIN accounts a ON a.id = r.owner_id;
--> statement-breakpoint
CREATE TRIGGER search_repositories_insert AFTER INSERT ON repositories
BEGIN
  INSERT INTO search_repositories (repository_id, owner, name, description, topics) SELECT new.id, login, new.name, '', '' FROM accounts WHERE id = new.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER search_repositories_update AFTER UPDATE OF name, owner_id ON repositories
BEGIN
  UPDATE search_repositories SET name = new.name, owner = (SELECT login FROM accounts WHERE id = new.owner_id) WHERE repository_id = new.id;
END;
--> statement-breakpoint
CREATE TRIGGER search_repositories_delete AFTER DELETE ON repositories
BEGIN
  DELETE FROM search_repositories WHERE repository_id = old.id;
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE search_accounts USING fts5(account_id UNINDEXED, login, display_name);
--> statement-breakpoint
INSERT INTO search_accounts (account_id, login, display_name) SELECT id, login, coalesce(display_name, '') FROM accounts;
--> statement-breakpoint
CREATE TRIGGER search_accounts_insert AFTER INSERT ON accounts
BEGIN
  INSERT INTO search_accounts (account_id, login, display_name) VALUES (new.id, new.login, coalesce(new.display_name, ''));
END;
--> statement-breakpoint
CREATE TRIGGER search_accounts_update AFTER UPDATE OF login, display_name ON accounts
BEGIN
  UPDATE search_accounts SET login = new.login, display_name = coalesce(new.display_name, '') WHERE account_id = new.id;
  UPDATE search_repositories SET owner = new.login WHERE repository_id IN (SELECT id FROM repositories WHERE owner_id = new.id);
END;
--> statement-breakpoint
CREATE TRIGGER search_accounts_delete AFTER DELETE ON accounts
BEGIN
  DELETE FROM search_accounts WHERE account_id = old.id;
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE search_issues USING fts5(title, body, content = 'issues', content_rowid = 'id');
--> statement-breakpoint
INSERT INTO search_issues (search_issues) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER search_issues_insert AFTER INSERT ON issues
BEGIN
  INSERT INTO search_issues (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_issues_update AFTER UPDATE OF title, body ON issues
BEGIN
  INSERT INTO search_issues (search_issues, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO search_issues (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_issues_delete AFTER DELETE ON issues
BEGIN
  INSERT INTO search_issues (search_issues, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE search_issue_comments USING fts5(body, content = 'issue_comments', content_rowid = 'id');
--> statement-breakpoint
INSERT INTO search_issue_comments (search_issue_comments) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER search_issue_comments_insert AFTER INSERT ON issue_comments
BEGIN
  INSERT INTO search_issue_comments (rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_issue_comments_update AFTER UPDATE OF body ON issue_comments
BEGIN
  INSERT INTO search_issue_comments (search_issue_comments, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO search_issue_comments (rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_issue_comments_delete AFTER DELETE ON issue_comments
BEGIN
  INSERT INTO search_issue_comments (search_issue_comments, rowid, body) VALUES ('delete', old.id, old.body);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE search_discussions USING fts5(title, body, content = 'discussions', content_rowid = 'id');
--> statement-breakpoint
INSERT INTO search_discussions (search_discussions) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER search_discussions_insert AFTER INSERT ON discussions
BEGIN
  INSERT INTO search_discussions (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_discussions_update AFTER UPDATE OF title, body ON discussions
BEGIN
  INSERT INTO search_discussions (search_discussions, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO search_discussions (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_discussions_delete AFTER DELETE ON discussions
BEGIN
  INSERT INTO search_discussions (search_discussions, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE search_discussion_comments USING fts5(body, content = 'discussion_comments', content_rowid = 'id');
--> statement-breakpoint
INSERT INTO search_discussion_comments (search_discussion_comments) VALUES ('rebuild');
--> statement-breakpoint
CREATE TRIGGER search_discussion_comments_insert AFTER INSERT ON discussion_comments
BEGIN
  INSERT INTO search_discussion_comments (rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_discussion_comments_update AFTER UPDATE OF body ON discussion_comments
BEGIN
  INSERT INTO search_discussion_comments (search_discussion_comments, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO search_discussion_comments (rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER search_discussion_comments_delete AFTER DELETE ON discussion_comments
BEGIN
  INSERT INTO search_discussion_comments (search_discussion_comments, rowid, body) VALUES ('delete', old.id, old.body);
END;
