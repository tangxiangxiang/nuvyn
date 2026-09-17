# User Guide Overview

Nuvyn is a Personal OS for your digital life. Its product model has four first-level Workspaces—Note, Diary, Ledger, and Board—while this guide describes current user-facing behavior and the shared capabilities that connect them. The product model and long-term design principles are documented in [Nuvyn — Personal OS](../product.md).

## Workspaces

| Workspace | What it is for |
| --- | --- |
| Note | What I know — knowledge and long-lived content |
| Diary | What I experience — time and personal experience |
| Ledger | What happens to my money — personal financial events |
| Board | What I am thinking — visual thinking and exploration |

These are specialized entry points in one Personal OS, not four unrelated apps. Shared files, metadata, links, search, history, security, and owner context may be implemented at system level even when a Workspace uses its own UI and data model.

## Main Areas

- **Files** browses the folder tree, creates and moves notes, and filters by path, title, and tag expressions.
- **Tags** lists normalized metadata tags and the notes assigned to each tag.
- **History** shows working-tree changes and Git versions, and supports comparison, restore, and withdrawal of the latest Nuvyn version.
- **Editor / Read mode** switches between Monaco Markdown editing and the sanitized rendered document.
- **Right rail** exposes the current document's outline, links, properties, file history, and AI chat.
- **Recovery** surfaces browser-persisted unsaved drafts after a reload, crash, or conflicting file operation.

## Where Data Lives

Markdown bodies live in the vault directory. Titles, summaries, tags, AI settings, and AI conversations live in SQLite. Version history lives in the vault's own `.git/`. Unsaved recovery drafts live in the current browser profile's IndexedDB.

These stores have different backup and portability properties. See [Storage Architecture](../architecture/storage.md) and [Backup and Restore](../deployment/backup-and-restore.md).

## Next Steps

- Learn the protected folder model in [Vault and Archive Protocol](vault.md).
- Review save and conflict behavior in [Editor and Draft Recovery](editor.md).
- Configure and use AI in [AI](ai.md).
