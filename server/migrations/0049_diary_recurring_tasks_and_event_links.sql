-- Recurring task rules are separate from per-date occurrence state. Private
-- content, recurrence rules, and occurrence status stay encrypted; civil date
-- columns are the only recurrence query indexes exposed in plaintext.
CREATE TABLE diary_task_series (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  start_date TEXT NOT NULL CHECK (
    length(start_date) = 10 AND start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND start_date >= '0001-01-01' AND date(start_date, '+0 days') = start_date
  ),
  effective_from TEXT NOT NULL CHECK (
    length(effective_from) = 10 AND effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND effective_from >= start_date AND date(effective_from, '+0 days') = effective_from
  ),
  until_date TEXT CHECK (
    until_date IS NULL OR (
      length(until_date) = 10 AND until_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND until_date >= effective_from AND date(until_date, '+0 days') = until_date
    )
  ),
  encrypted_fields BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (owner_user_id, id)
);
CREATE INDEX idx_diary_task_series_range ON diary_task_series(owner_user_id, effective_from, until_date, id);

CREATE TABLE diary_task_series_deleted_records (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (owner_user_id, id)
);

CREATE TABLE diary_task_occurrences (
  owner_user_id INTEGER NOT NULL,
  series_id TEXT NOT NULL,
  occurrence_date TEXT NOT NULL CHECK (
    length(occurrence_date) = 10 AND occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND occurrence_date >= '0001-01-01' AND date(occurrence_date, '+0 days') = occurrence_date
  ),
  encrypted_fields BLOB NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, series_id, occurrence_date),
  FOREIGN KEY (owner_user_id, series_id) REFERENCES diary_task_series(owner_user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_diary_task_occurrences_range ON diary_task_occurrences(owner_user_id, occurrence_date, series_id);

-- Links contain only record IDs. Cascades remove relationships while preserving
-- the independent task and event records.
CREATE TABLE diary_task_event_links (
  owner_user_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, task_id),
  FOREIGN KEY (owner_user_id, task_id) REFERENCES diary_tasks(owner_user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, event_id) REFERENCES diary_events(owner_user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_diary_task_event_links_event ON diary_task_event_links(owner_user_id, event_id, task_id);
