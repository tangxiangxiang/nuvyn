# History

History gives the Markdown vault its own Git repository, separate from the Nuvyn source repository.

## Create a Version

1. Open History and review the Changes list.
2. Select the Markdown paths to include.
3. Enter a version message or generate one with the configured AI provider.
4. Choose **Create Version**.

Nuvyn first saves the selected open editor revisions, captures their content hashes, and commits only if the working files still match. The commit carries Nuvyn version and vault-identity trailers.

The vault repository is initialized lazily the first time History is used. Nuvyn creates a vault `.git/`, a `.nuvyn/vault-id` marker, and default ignore files if they do not already exist. Git must be installed and reachable on `PATH`.

## Browse and Compare

The timeline groups versions by local calendar date. Open a version to compare it with its parent or with the current working tree. File History narrows the timeline to the active document. Historical views are read-only.

## Restore

Restore replaces the working-tree content with a selected historical revision after a confirmation. It does not create a new commit. Review the resulting change and create a new version if you want the restore recorded.

## Withdraw the Latest Version

Withdraw removes only the current latest Nuvyn-created version and keeps its file changes in the working tree. Older commits, merge commits, foreign commits, and legacy versions whose vault identity cannot be verified are not eligible.

## Limits and Recovery

- Nuvyn History is intended for a personal, single-vault workflow. Finish or cancel external merges, rebases, and similar repository operations before using it.
- Concurrent repository or file changes cause a conflict rather than a partial silent commit.
- If post-commit index synchronization fails, the UI retains a repair record and offers a guarded retry. Inspect Git manually if repair-state persistence also fails.
- Back up the entire vault, including its hidden `.git/` and `.nuvyn/` entries. Copying only `*.md` files loses versions and vault identity.

See [History Architecture](../architecture/history.md) for the repository contracts.
