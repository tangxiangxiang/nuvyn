-- A task links to one concrete Event occurrence, not to an entire recurring
-- Event series. Existing links were restricted to non-recurring Events, so
-- their only occurrence is the Event's original start date.
CREATE TABLE diary_task_event_links_next (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL CHECK (
    length(occurrence_date) = 10 AND occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND occurrence_date >= '0001-01-01' AND date(occurrence_date, '+0 days') = occurrence_date
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, task_id),
  FOREIGN KEY (owner_user_id, task_id) REFERENCES diary_tasks(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, event_id) REFERENCES diary_events(owner_user_id, id) ON DELETE CASCADE
);

-- COALESCE deliberately makes an inconsistent historical link fail the
-- occurrence_date CHECK. Since migrations run transactionally, the old link
-- table remains intact and the invalid row can be diagnosed and repaired.
INSERT INTO diary_task_event_links_next (owner_user_id, task_id, event_id, occurrence_date, created_at)
SELECT link.owner_user_id, link.task_id, link.event_id, COALESCE(event.start_date, ''), link.created_at
FROM diary_task_event_links link
LEFT JOIN diary_events event
  ON event.owner_user_id = link.owner_user_id AND event.id = link.event_id;

DROP TABLE diary_task_event_links;
ALTER TABLE diary_task_event_links_next RENAME TO diary_task_event_links;
CREATE INDEX idx_diary_task_event_links_event_occurrence
  ON diary_task_event_links(owner_user_id, event_id, occurrence_date, task_id);
