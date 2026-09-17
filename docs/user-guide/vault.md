# Vault, Diary, and Archive Protocol

## Vault Layout

A vault is a directory of Markdown files. By default it is `src/content/`; production deployments can use `VAULT_DIR`, and Docker mounts the host's `./src/content` at `/app/src/content`.

Nuvyn requires portable, URL-safe logical paths: every folder and file-name segment uses lowercase ASCII letters, digits, and internal hyphens. The `.md` suffix is stored on disk but omitted from Nuvyn paths and URLs. Display titles may use any language because they live in document metadata.

## Protected Roots

The four top-level folders are part of the product protocol:

- `inbox/` for new and unfinished notes.
- `literature/` for source-oriented reading notes.
- `archive/` for settled notes.
- `diary/` for one date-addressed Diary document per local calendar date.

The roots themselves cannot be renamed, deleted, or moved. Missing roots are created by the shared startup seed without overwriting a conflicting file.

## Archive Rules

`archive/` is a recommended organizational area for inactive content, not an immutable or compliance archive:

- The top-level `archive` directory is reserved by Nuvyn so the built-in Archive action has a stable destination.
- `archive/` descendants follow the same file and folder operations available to ordinary Nuvyn content.
- Files can be created, edited, renamed, deleted, and moved within or out of the archive.
- Folders can be created, renamed, and deleted normally. General folder re-parenting is not currently a Nuvyn capability.
- Content from any otherwise-legal location can be moved into `archive/`.
- The built-in Archive action remains a convenience workflow and defaults to `archive/<filename>`, with its existing collision suffix handling.

The UI and server protect only the reserved root names. Filesystem confinement, path validation, authentication, lifecycle coordination, history, and recovery guarantees are unchanged.

## Diary Rules

`diary/` is a reserved Calendar-first scope, not a second editor or a general folder tree:

- A managed Diary entry uses the logical path `diary/YYYY-MM-DD` and the physical file `diary/YYYY-MM-DD.md`.
- One valid local calendar date maps to exactly one Diary document. The date command owns creation for Today and past dates; a missing future date is not created.
- Existing future dates can be opened and edited. Managed Diary documents can be deleted through the normal lifecycle, but their identity cannot be renamed or moved.
- Generic file/folder creation under `diary/` is rejected so arbitrary content cannot become a managed Diary identity. Existing unmanaged or invalid files remain visible to FileTree, but Calendar ignores them.
- Diary entries continue to use the ordinary editor, History, Recovery, and save/delete lifecycle. Diary does not change the vault's authentication or filesystem-confinement rules.

## File Operations

The file tree supports create, rename, move, recursive folder deletion, document properties, link-aware renames, and archive actions. Before a rename, Nuvyn can update incoming Wiki and Markdown references. Mutations are serialized against editor saves, History actions, and other lifecycle work; a conflicting operation is rejected instead of silently overwriting another writer.

See [Document Lifecycle Architecture](../architecture/document-lifecycle.md) for the implementation guarantees.
