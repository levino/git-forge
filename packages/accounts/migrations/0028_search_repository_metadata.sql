DROP TRIGGER search_repositories_insert;
--> statement-breakpoint
CREATE TRIGGER search_repositories_insert AFTER INSERT ON repositories
BEGIN
  INSERT INTO search_repositories (repository_id, owner, name, description, topics)
  SELECT new.id, login, new.name, coalesce(new.description, ''), coalesce((SELECT group_concat(value, ' ') FROM json_each(new.topics)), '') FROM accounts WHERE id = new.owner_id;
END;
--> statement-breakpoint
DROP TRIGGER search_repositories_update;
--> statement-breakpoint
CREATE TRIGGER search_repositories_update AFTER UPDATE OF name, owner_id, description, topics ON repositories
BEGIN
  UPDATE search_repositories SET name = new.name, owner = (SELECT login FROM accounts WHERE id = new.owner_id), description = coalesce(new.description, ''),
    topics = coalesce((SELECT group_concat(value, ' ') FROM json_each(new.topics)), '')
  WHERE repository_id = new.id;
END;
--> statement-breakpoint
DELETE FROM search_repositories;
--> statement-breakpoint
INSERT INTO search_repositories (repository_id, owner, name, description, topics)
SELECT r.id, a.login, r.name, coalesce(r.description, ''), coalesce((SELECT group_concat(value, ' ') FROM json_each(r.topics)), '') FROM repositories r JOIN accounts a ON a.id = r.owner_id;
