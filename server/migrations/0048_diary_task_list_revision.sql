-- A per-owner revision invalidates task cursors when list membership or order
-- changes. The signing key makes cursors tamper-evident across server restarts.
CREATE TABLE diary_task_list_revisions (
  owner_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991)
);

INSERT INTO diary_task_list_revisions (owner_user_id, revision)
SELECT DISTINCT owner_user_id, 0 FROM diary_tasks;

CREATE TABLE diary_task_list_cursor_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret BLOB NOT NULL CHECK (length(secret) = 32)
);

INSERT INTO diary_task_list_cursor_key (id, secret) VALUES (1, randomblob(32));
