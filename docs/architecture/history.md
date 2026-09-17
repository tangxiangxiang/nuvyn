# History Architecture

Nuvyn history is built on Git, but it is scoped to the configured vault and presented as document versions rather than as a general Git client.

## Repository identity

The history service lazily initializes a Git repository in the vault. It writes `.nuvyn/vault-id`, configures vault-specific ignore rules and `core.autocrlf=false`, and uses Nuvyn technical commit trailers to distinguish versions created by the current application:

```text
Nuvyn-Version: 1
Nuvyn-Vault: <vault-id>
Nuvyn-Vault-Version: 1
```

History trailers use the canonical Nuvyn format and are validated against the current vault identity.

The vault repository is separate from the Nuvyn source repository. Running Nuvyn inside this checkout therefore creates history below `src/content/`, not in the outer development repository.

## Creating a version

Creating a version is explicit. The client first coordinates and flushes relevant pending saves. The server hashes content, determines changes, creates a commit with the Nuvyn trailers, and returns the new timeline state. Autosave alone does not create a version.

## Reading history

The API exposes:

- a version timeline;
- working-tree changes relative to recorded content;
- file-level history;
- unified and content comparisons.

Timeline logic recognizes Nuvyn versions by both trailers and vault identity, so unrelated commits are not treated as managed versions.

## Restore and withdraw

Restore writes selected historical content into the current working tree. It intentionally does not auto-commit; the user can review the result and create a new version.

Withdraw is limited to the latest eligible Nuvyn version. It moves the version out of the managed timeline while leaving its file changes in the working tree, avoiding silent content loss.

## Operational requirements

Git must be installed and available to the server process. The complete vault, including its `.git` directory, must be backed up. See [User Guide: History](../user-guide/history.md) and [Backup and Restore](../deployment/backup-and-restore.md).
