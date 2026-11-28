-- Life Period has no upper bound on duration and may have no end date.
-- Replace the old indexed end_date column without rebuilding diary_events,
-- preserving the existing task-to-event foreign keys.
DROP INDEX idx_diary_events_range;
ALTER TABLE diary_events RENAME COLUMN end_date TO legacy_end_date;
ALTER TABLE diary_events ADD COLUMN end_date TEXT CHECK (
  end_date IS NULL OR (
    length(end_date) = 10
    AND end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND end_date >= '0001-01-01'
    AND date(end_date, '+0 days') IS NOT NULL
    AND date(end_date, '+0 days') = end_date
    AND end_date >= start_date
  )
);
UPDATE diary_events SET end_date = legacy_end_date;
ALTER TABLE diary_events DROP COLUMN legacy_end_date;
CREATE INDEX idx_diary_events_range ON diary_events(owner_user_id, start_date, end_date);

CREATE TABLE diary_event_attachments (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT,
  stage_event_id TEXT,
  encrypted_metadata BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'attached', 'deleting')),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  request_key TEXT,
  stage_session_id TEXT,
  UNIQUE (owner_user_id, request_key),
  FOREIGN KEY (owner_user_id, event_id) REFERENCES diary_events(owner_user_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'staged' AND event_id IS NULL AND stage_event_id IS NOT NULL AND expires_at IS NOT NULL AND stage_session_id IS NOT NULL)
    OR (status = 'attached' AND event_id IS NOT NULL AND stage_event_id IS NULL AND expires_at IS NULL AND stage_session_id IS NULL)
    OR (status = 'deleting' AND event_id IS NULL AND stage_event_id IS NULL AND expires_at IS NULL AND stage_session_id IS NULL)
  )
);
CREATE INDEX idx_diary_event_attachments_event
  ON diary_event_attachments(owner_user_id, event_id, status, display_order, id);
CREATE INDEX idx_diary_event_attachments_expiry
  ON diary_event_attachments(status, expires_at);
CREATE INDEX idx_diary_event_attachments_stage_session
  ON diary_event_attachments(owner_user_id, stage_event_id, stage_session_id, status, expires_at);

-- Preserve encrypted files as retryable cleanup tombstones when an event is deleted.
CREATE TRIGGER diary_events_mark_attachments_deleting
BEFORE DELETE ON diary_events
BEGIN
  UPDATE diary_event_attachments
  SET status = 'deleting', event_id = NULL, stage_event_id = NULL,
      expires_at = NULL, stage_session_id = NULL
  WHERE owner_user_id = OLD.owner_user_id
    AND (event_id = OLD.id OR stage_event_id = OLD.id)
    AND status IN ('staged', 'attached');
END;
