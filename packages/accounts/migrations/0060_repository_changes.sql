CREATE TABLE repository_changes (
  repository_id TEXT PRIMARY KEY,
  counter INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER repository_changes_issues_insert AFTER INSERT ON issues
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issues_update AFTER UPDATE ON issues
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issues_delete AFTER DELETE ON issues
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_labels_insert AFTER INSERT ON labels
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_labels_update AFTER UPDATE ON labels
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_labels_delete AFTER DELETE ON labels
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_milestones_insert AFTER INSERT ON milestones
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_milestones_update AFTER UPDATE ON milestones
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_milestones_delete AFTER DELETE ON milestones
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_releases_insert AFTER INSERT ON releases
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_releases_update AFTER UPDATE ON releases
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_releases_delete AFTER DELETE ON releases
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_commit_statuses_insert AFTER INSERT ON commit_statuses
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_commit_statuses_update AFTER UPDATE ON commit_statuses
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_commit_statuses_delete AFTER DELETE ON commit_statuses
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_check_runs_insert AFTER INSERT ON check_runs
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_check_runs_update AFTER UPDATE ON check_runs
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_check_runs_delete AFTER DELETE ON check_runs
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussion_categories_insert AFTER INSERT ON discussion_categories
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussion_categories_update AFTER UPDATE ON discussion_categories
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussion_categories_delete AFTER DELETE ON discussion_categories
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussions_insert AFTER INSERT ON discussions
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussions_update AFTER UPDATE ON discussions
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussions_delete AFTER DELETE ON discussions
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_collaboration_settings_insert AFTER INSERT ON collaboration_settings
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_collaboration_settings_update AFTER UPDATE ON collaboration_settings
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_collaboration_settings_delete AFTER DELETE ON collaboration_settings
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_branch_protection_rules_insert AFTER INSERT ON branch_protection_rules
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_branch_protection_rules_update AFTER UPDATE ON branch_protection_rules
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_branch_protection_rules_delete AFTER DELETE ON branch_protection_rules
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_reactions_insert AFTER INSERT ON reactions
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_reactions_update AFTER UPDATE ON reactions
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_reactions_delete AFTER DELETE ON reactions
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_imported_items_insert AFTER INSERT ON imported_items
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_imported_items_update AFTER UPDATE ON imported_items
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_imported_items_delete AFTER DELETE ON imported_items
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_comments_insert AFTER INSERT ON issue_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_comments_update AFTER UPDATE ON issue_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_comments_delete AFTER DELETE ON issue_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_labels_insert AFTER INSERT ON issue_labels
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_labels_update AFTER UPDATE ON issue_labels
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_labels_delete AFTER DELETE ON issue_labels
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_assignees_insert AFTER INSERT ON issue_assignees
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_assignees_update AFTER UPDATE ON issue_assignees
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_assignees_delete AFTER DELETE ON issue_assignees
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_events_insert AFTER INSERT ON issue_events
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_events_update AFTER UPDATE ON issue_events
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_issue_events_delete AFTER DELETE ON issue_events
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_pull_requests_insert AFTER INSERT ON pull_requests
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_pull_requests_update AFTER UPDATE ON pull_requests
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_pull_requests_delete AFTER DELETE ON pull_requests
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_review_requests_insert AFTER INSERT ON review_requests
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_review_requests_update AFTER UPDATE ON review_requests
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_review_requests_delete AFTER DELETE ON review_requests
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_pull_request_reviews_insert AFTER INSERT ON pull_request_reviews
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_pull_request_reviews_update AFTER UPDATE ON pull_request_reviews
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_pull_request_reviews_delete AFTER DELETE ON pull_request_reviews
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_review_comments_insert AFTER INSERT ON review_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_review_comments_update AFTER UPDATE ON review_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = new.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = new.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_review_comments_delete AFTER DELETE ON review_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM issues WHERE id = old.issue_id), 1 WHERE (SELECT repository_id FROM issues WHERE id = old.issue_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussion_comments_insert AFTER INSERT ON discussion_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM discussions WHERE id = new.discussion_id), 1 WHERE (SELECT repository_id FROM discussions WHERE id = new.discussion_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussion_comments_update AFTER UPDATE ON discussion_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM discussions WHERE id = new.discussion_id), 1 WHERE (SELECT repository_id FROM discussions WHERE id = new.discussion_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_discussion_comments_delete AFTER DELETE ON discussion_comments
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM discussions WHERE id = old.discussion_id), 1 WHERE (SELECT repository_id FROM discussions WHERE id = old.discussion_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_release_assets_insert AFTER INSERT ON release_assets
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM releases WHERE id = new.release_id), 1 WHERE (SELECT repository_id FROM releases WHERE id = new.release_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_release_assets_update AFTER UPDATE ON release_assets
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM releases WHERE id = new.release_id), 1 WHERE (SELECT repository_id FROM releases WHERE id = new.release_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_release_assets_delete AFTER DELETE ON release_assets
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT (SELECT repository_id FROM releases WHERE id = old.release_id), 1 WHERE (SELECT repository_id FROM releases WHERE id = old.release_id) IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_repository_forks_insert AFTER INSERT ON repository_forks
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
  INSERT INTO repository_changes (repository_id, counter) SELECT new.parent_id, 1 WHERE new.parent_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_repository_forks_update AFTER UPDATE ON repository_forks
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT new.repository_id, 1 WHERE new.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
  INSERT INTO repository_changes (repository_id, counter) SELECT new.parent_id, 1 WHERE new.parent_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
--> statement-breakpoint
CREATE TRIGGER repository_changes_repository_forks_delete AFTER DELETE ON repository_forks
BEGIN
  INSERT INTO repository_changes (repository_id, counter) SELECT old.repository_id, 1 WHERE old.repository_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
  INSERT INTO repository_changes (repository_id, counter) SELECT old.parent_id, 1 WHERE old.parent_id IS NOT NULL ON CONFLICT (repository_id) DO UPDATE SET counter = counter + 1;
END;
