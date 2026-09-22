# Backup and Restore

Nuvyn server persistence spans the vault, the data directory, and any externally managed master key. Browser drafts are a separate local recovery layer and cannot be captured by a normal server backup.

| Data | Default location | Backup requirement |
| --- | --- | --- |
| Markdown notes | `src/content/**/*.md` | Required. |
| Vault versions and identity | `src/content/.git/`, `src/content/.nuvyn/`, vault dotfiles | Required if History must survive. |
| SQLite metadata, AI data, Authentication v1 state, and Ledger financial state | `data/nuvyn.db` plus active WAL/SHM files | Required for titles, summaries, tags, document IDs, migration records, `users`, `auth_instance`, `auth_sessions`, AI settings, encrypted credentials, sessions, messages, and Ledger's `ledger_settings`, `ledger_accounts`, `ledger_categories`, `ledger_transactions`, and `ledger_idempotency` tables. |
| AI master key | `data/.nuvyn-master-key` or an external environment/secret file | Required to decrypt stored AI credentials. |
| Unsaved drafts | Browser IndexedDB `nuvyn-draft-recovery` | Browser-local; not included in server or Docker backups. |

A complete server backup includes the full vault, the full data directory, and the master key when it is managed outside `data/`.

Ledger has no separate database and does not store financial records in
Markdown. Its five `ledger_*` tables are server-owned structured state in the
same SQLite database as metadata, authentication, and AI. The
`ledger_idempotency` table is create-mutation retry-safety state: it is not a
financial business record, but it must be backed up and restored together
with the Ledger business rows. Do not clear it as a normal restore step, or a
response-loss retry could execute a mutation a second time.

## Authentication State

Authentication v1 state is part of the same SQLite database:

- `users` stores the single owner's canonical username, password hash, disabled flag, and timestamps.
- `auth_instance` stores the singleton owner relationship for this Nuvyn instance.
- `auth_sessions` stores session metadata and token hashes, never raw session tokens.

A database backup therefore includes owner metadata and may include sessions
that are still within their fixed 7-day lifetime. The setup token is not part
of the database backup: an explicit `NUVYN_SETUP_TOKEN` belongs in the
operator's secret management, while a generated fallback exists only in the
process memory that created it and is not recoverable from SQLite.

Treat a restore from an untrusted, shared, older, or incident-affected backup
as an authentication event. Set `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` for
the first startup after the restore, then return it to `0` for normal restarts.
This revokes restored sessions before requests are accepted; do not recommend
editing `auth_sessions`, `users`, or `auth_instance` directly.

In fallback mode, `data/nuvyn.db` and `data/.nuvyn-master-key` are a recovery
pair and must be backed up and restored together. Restoring only SQLite leaves
AI credentials encrypted with that fallback key unreadable. Nuvyn reports
`master-key-required`; it does not create a replacement key, rewrite the
ciphertext, or change other AI settings.

## Consistency Rule

Stop Nuvyn before copying `data/` and the vault. This closes SQLite cleanly and prevents a document mutation from spanning the two backup copies.

If zero-downtime backups are required, use a filesystem snapshot that covers
both stores at the same point in time and a SQLite-aware backup process. A
plain live copy of only `nuvyn.db` can miss Ledger or other data still in the
WAL. The WAL and SHM files belong to the same SQLite consistency boundary;
prefer stopping Nuvyn or using a SQLite-aware backup rather than copying only
the main database file.

## Docker Backup

From the repository directory:

```bash
docker compose stop nuvyn
mkdir -p backups/data backups/vault
docker cp nuvyn:/app/data/. backups/data/
rsync -a src/content/ backups/vault/
docker compose start nuvyn
```

On systems without `rsync`, use an archive tool that includes hidden files. Confirm that `backups/vault/.git/` and `backups/vault/.nuvyn/` exist when those features have been initialized.

The `backups/data/` copy includes the auto-managed master key. If `NUVYN_MASTER_KEY` / `NUVYN_MASTER_KEY_FILE` is used instead, back up that secret separately in a protected secret store.

## Bare-Metal Backup

Stop the service manager, then copy both configured locations recursively:

```bash
rsync -a /path/to/vault/ /path/to/backup/vault/
rsync -a /path/to/nuvyn/data/ /path/to/backup/data/
```

Store the external master key separately if it is not under `data/`.

## Restore Order

1. Stop Nuvyn.
2. Restore the complete vault, including hidden `.git/` and `.nuvyn/` content.
3. Restore the complete `data/` directory or Docker volume contents, not only `nuvyn.db`.
4. Restore the same external master key configuration used when the AI credentials were encrypted.
5. Ensure the runtime user can read and write the restored paths.
6. If the restore should force reauthentication, set `NUVYN_AUTH_REVOKE_SESSIONS_ON_START=1` before starting Nuvyn.
7. Start Nuvyn and inspect startup logs; reset the flag to `0` after the one-shot invalidation has run.
8. Verify `/api/health`, authenticate the owner, open representative notes, check tags and properties, inspect History, and test AI settings without replacing the key.
9. If Ledger has been initialized, use the authenticated owner boundary to verify `GET /api/ledger/settings`, `GET /api/ledger/accounts`, `GET /api/ledger/overview`, and `GET /api/ledger/transactions?limit=1`. These checks verify that Ledger settings, entities, financial records, current projections, and read APIs are available; Ledger UI is not required for restore verification.

For Docker, one restore method that preserves the existing named volume is:

```bash
docker compose stop nuvyn
docker compose run --rm --no-deps -v "$PWD/backups/data:/restore:ro" nuvyn \
  sh -c 'find /app/data -mindepth 1 -delete && cp -a /restore/. /app/data/'
rsync -a --delete backups/vault/ src/content/
docker compose up -d
```

The `--delete` flag makes the restored vault match the backup and removes newer files, so review both paths carefully before running it. Restore to a separate test directory first when the backup has not been verified recently.

## Partial Restore Consequences

- Markdown without SQLite retains note bodies but loses current database-owned titles, summaries, tags, stable IDs, AI settings, and conversations. Startup will reconstruct fallback metadata, not the missing application state.
- A vault-only restore cannot restore Ledger Settings, Accounts, Categories, Transactions, current projections, or idempotency replay state.
- A SQLite restore includes Ledger rows and replay state, but restoring it without the matching vault can still leave the document side of the Nuvyn instance inconsistent.
- SQLite without the matching vault contains metadata identities for missing files and is not a useful document restore.
- SQLite without the matching master key preserves encrypted credentials but cannot decrypt them. Restore the original key. If the credentials are intentionally abandoned, the old credential rows must be explicitly cleared before reconfiguration; Nuvyn does not clear or replace them during the failed read.
- If the original key cannot be recovered, Settings can explicitly forget one provider credential at a time. This destructive action removes only the selected encrypted row; it does not decrypt, rewrite, or remove the other provider's row or the master-key file. Once all unrecoverable rows are cleared, a new API key can be saved and a new fallback key will be created.
- Vault files without `.git/` lose History even though current Markdown remains.
- Clearing browser storage loses unsaved recovery drafts but does not delete server-saved notes.
- Restoring only `data/nuvyn.db` can restore owner/session metadata without the vault; restoring a backup without the matching database can lose authentication state. Restore the complete instance stores together.
