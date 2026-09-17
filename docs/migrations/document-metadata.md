# Document Metadata Migration

Nuvyn stores document metadata in SQLite while keeping Markdown bodies in the vault. The migration service imports legacy frontmatter and provides guarded cleanup and restoration through Settings.

## Current metadata model

| Field | SQLite representation | Import fallback |
| --- | --- | --- |
| Stable identity | `documents.id` | Generated on first import |
| Current path | `documents.path` | Vault-relative Markdown path |
| Title | `documents.title` | Frontmatter title, first H1, then filename |
| Summary | `documents.summary` | Frontmatter summary or empty string |
| Tags | `tags` + `document_tags` | Frontmatter tags, normalized and deduplicated |
| Created time | `documents.created_at` | Frontmatter `created`/legacy `date`, then file data |
| Updated time | `documents.updated_at` | Frontmatter `updated` and file modification time |

Aliases are not part of the current metadata schema; migration `0005_drop_document_aliases.sql` removes the earlier table. Document bodies remain files, not database rows.

## When migration runs

The development plugin and production server scan the configured vault at startup. Production runs crash recovery first, then metadata migration. A migration can also be triggered from the metadata API.

The scanner includes Markdown below dot-prefixed vault folders but skips `.git`. It imports without changing file contents, verifies the database read-back, and records progress in `metadata_migrations`.

## Status lifecycle

| Status | Meaning |
| --- | --- |
| `legacy` | Source observed; import not yet verified |
| `imported` | Metadata written to SQLite |
| `verified` | Stored values read back successfully |
| `cleaned` | Legacy frontmatter removed with a retained backup |
| `failed` | Import or verification failed; error retained |
| `orphaned` | The recorded file no longer exists at that path |

Records bind to stable document IDs. Rename and move operations update their paths. A deleted path becomes a tombstone rather than being confused with a later, different document created at the same path.

## Safe cleanup

Settings → Document metadata can preview frontmatter removal. Cleanup is allowed only for eligible, verified documents and requires explicit confirmation. Before replacement, Nuvyn checks hashes and document identity, stores the exact original frontmatter, and uses the normal write lock and atomic file path.

The preview identifies blocked documents and custom fields. Do not remove frontmatter while any preview item is blocked; resolve migration failures or concurrent file changes first.

## Restore and export

Cleaned documents can restore either:

- `original`: the exact backed-up frontmatter; or
- `canonical`: frontmatter reconstructed from current SQLite metadata.

The API can also export original or canonical frontmatter without changing the file. Restore guards track later body writes so a stale cleanup hash is not blindly applied.

## Operational guidance

- Back up both the vault and `data/` before bulk cleanup.
- Let Nuvyn lifecycle APIs handle rename, move, and delete so stable identities stay coordinated.
- Treat a `failed` count as actionable; inspect logs and do not force file cleanup.
- Do not hand-edit `metadata_migrations` or remove backup fields from SQLite.
- Keep the database and vault together when restoring a snapshot.

See [Storage Architecture](../architecture/storage.md) and [Backup and Restore](../deployment/backup-and-restore.md).

