ALTER TABLE metadata_migrations
  ADD COLUMN frontmatter_backup TEXT NOT NULL DEFAULT '';

ALTER TABLE metadata_migrations
  ADD COLUMN cleaned_hash TEXT NOT NULL DEFAULT '';
