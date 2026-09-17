# Storage Architecture

Nuvyn deliberately separates human-owned Markdown, application metadata, browser recovery data, and version history.

## Vault files

The default vault is `src/content/`; `VAULT_DIR` can point the server elsewhere. It contains the required top-level roots `inbox/`, `literature/`, `archive/`, and `diary/` plus a small amount of Nuvyn-managed repository metadata.

Vault paths are validated before use. Folder and file path segments use lowercase ASCII kebab-case; display titles may use any language.

## SQLite

The server opens the single `data/nuvyn.db` database and applies migrations
from `server/migrations/`. SQLite uses write-ahead logging; the database,
`nuvyn.db-wal`, and `nuvyn.db-shm` are one consistency boundary. There is no
second Ledger database. The same SQLite instance is shared with document
metadata, authentication, and AI state.

It stores:

- stable document identities and metadata such as title, summary, and tags;
- metadata-migration backup records;
- AI provider settings, sessions, and messages.
- Ledger server-owned structured financial state in:
  `ledger_settings`, `ledger_accounts`, `ledger_categories`,
  `ledger_transactions`, and `ledger_idempotency`.

Ledger does not write transactions to `ledger/*.md` or to Note/Diary
frontmatter. Its financial source of truth is the Ledger rows in SQLite plus
the shared server-side balance rules. `ledger_accounts` has no persisted
current-balance column: an account's current balance is derived from its
opening balance and the effects of active transaction rows. Overview and
other summaries are live projections, not persisted snapshots or caches.

Removing `data/nuvyn.db` does not remove the vault, but it loses application
metadata, AI history, authentication state, Ledger Settings, Accounts,
Categories, Transactions, and the `ledger_idempotency` retry-safety state.
Restoring only the database without the matching vault can leave stale
document records; restoring only the vault cannot restore Ledger financial
history.

## Vault Git repository

History uses a Git repository inside the configured vault, not the Git repository containing Nuvyn source code. Nuvyn initializes it lazily and creates `.nuvyn/vault-id` so its own version commits can be recognized.

The vault Git repository records Markdown history. It does not replace a backup: filesystem loss, a damaged `.git`, or deletion of the entire volume can still destroy history.

## Browser storage

Unsaved draft recovery uses IndexedDB database `nuvyn-draft-recovery`. Draft identities combine the vault ID and stable document ID so a rename does not orphan a draft.

Draft storage is deliberately bounded:

- maximum 2 MiB for one draft;
- maximum 100 records per vault;
- maximum 20 MiB per vault.

The data is local to one browser profile. Clearing site data, changing browsers, or using another device does not transfer it.

## Operational consequence

A complete backup includes both:

1. the configured vault directory, including hidden files and its `.git`; and
2. the `data/` directory, including the database and master-key file if present.

See [Backup and Restore](../deployment/backup-and-restore.md) for procedures.
