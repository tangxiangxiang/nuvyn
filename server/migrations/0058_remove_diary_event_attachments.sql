-- Do not discard Event attachments during an automatic upgrade. The v57
-- application must export attached files and finish staged/deleting cleanup
-- before this forward migration can proceed.
CREATE TEMP TABLE diary_event_attachment_migration_guard (value INTEGER);
CREATE TEMP TRIGGER diary_event_attachment_migration_guard_check
BEFORE INSERT ON diary_event_attachment_migration_guard
WHEN EXISTS (SELECT 1 FROM diary_event_attachments)
BEGIN
  SELECT RAISE(ABORT, 'Cannot remove Diary Event attachments while records exist. Export attached files and clean staged, attached, and deleting records with the v57 application, then retry the upgrade.');
END;
INSERT INTO diary_event_attachment_migration_guard VALUES (1);
DROP TRIGGER diary_event_attachment_migration_guard_check;
DROP TABLE diary_event_attachment_migration_guard;

DROP INDEX IF EXISTS idx_diary_event_attachments_event;
DROP INDEX IF EXISTS idx_diary_event_attachments_expiry;
DROP INDEX IF EXISTS idx_diary_event_attachments_stage_session;
DROP TRIGGER IF EXISTS diary_events_mark_attachments_deleting;
DROP TABLE diary_event_attachments;
