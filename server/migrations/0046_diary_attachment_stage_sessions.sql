-- Staged uploads are leased to an in-memory Diary editing session so abandoned
-- uploads can be reclaimed without deleting another active device's work.
ALTER TABLE diary_day_attachments ADD COLUMN stage_session_id TEXT;

CREATE INDEX idx_diary_day_attachments_stage_session
  ON diary_day_attachments(owner_user_id, day_date, stage_session_id, status, expires_at);
