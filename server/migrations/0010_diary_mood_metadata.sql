-- D7.1: live Diary Mood metadata.
--
-- The existing documents table remains the sole live metadata owner.  Mood is
-- intentionally nullable and unconstrained here: the write boundary accepts
-- only the current shared registry, while reads/history preserve future IDs
-- opaquely for forward compatibility.

ALTER TABLE documents ADD COLUMN mood TEXT NULL;
