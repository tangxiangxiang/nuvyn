# Editor and Draft Recovery

## Editing

Nuvyn uses Monaco for Markdown source editing and a separate Read mode for rendered output. There is no split Preview mode. Use the navigation-bar toggle to switch modes.

## PDF Export

### Export from File Tree

Right-click a Markdown document in the File Tree and choose **导出 PDF** / **Export PDF**. Folders do not have this action.

PDF export is available only from the File Tree context menu. It does not add controls to the reading or editing surface.

### What gets exported

Nuvyn renders the current Markdown document and downloads an A4 portrait PDF directly. The result is a semantic, print-optimized equivalent of Read Mode rather than a pixel-identical copy of the app. It includes, when present:

- headings, paragraphs, lists and task lists;
- quotes, callouts, links and footnotes;
- code blocks and tables;
- Chinese, Japanese, English and Emoji;
- rendered KaTeX formulas;
- rendered/static Mermaid and MarkMap diagrams;
- local and normally loadable images.

KaTeX, Mermaid and MarkMap are exported as their rendered/static result. Reader-only diagram controls such as pan and zoom are not included.

### Unsaved and closed documents

If the document is open and has unsaved edits, PDF Export uses the current live editing buffer. You do not need to save first. Export does not force a save, change the dirty state, or create a Git commit.

If the document is not open, File Tree export reads the authoritative document in the background. It does not open a visible tab or change the current workspace.

### PDF format and filename

The download is a `.pdf` file with an A4 portrait, light, print-friendly layout. The filename is selected from these sources, in order:

1. frontmatter `title`;
2. the first Markdown H1;
3. the document title;
4. the filename without `.md`;
5. `nuvyn-document`.

The selected title is sanitized for a filesystem filename while preserving Unicode.

Even when Nuvyn is in Dark Mode, the exported document uses a printable Light Theme. Images are allowed to settle before capture; remote images remain subject to browser CORS rules, so CORS-compatible images are best effort and incompatible remote images are not used to weaken browser security.

The PDF uses A4 portrait pagination. Code and tables adapt to the printable width, and content that is taller than one page may continue onto later pages.

### Export status and failure recovery

Only one PDF export can run at a time. Additional export requests are rejected until the current export finishes.

If an export fails, Nuvyn ends the transaction and removes its temporary export surface. The document and workspace remain available, and you can try the export again.

Each open document has its own workspace tab and unsaved buffer. Useful shortcuts include:

| Action | Shortcut |
| --- | --- |
| Save now | `Ctrl+S` / `Command+S` |
| Close active tab | `Ctrl+W` / `Command+W` |
| Open command palette | `Ctrl+P` / `Command+P` |
| Toggle Files panel | `Ctrl+B` / `Command+B` |

Edits are marked dirty immediately and are saved after 800 ms without another keystroke. If more typing occurs while a request is in flight, Nuvyn acknowledges that revision and then saves the newer one.

## External Changes and Conflicts

Every save sends both the intended content and the last content read from disk. If another application changed the file, the server returns the current disk version instead of overwriting it. The editor enters an external-change state so you can choose which content to keep.

Closing, renaming, moving, deleting, restoring, or versioning a document first establishes a mutation barrier. Pending saves are settled or paused before the lifecycle operation proceeds.

## Browser Draft Recovery

Unsaved buffers are also persisted to IndexedDB under the database `nuvyn-draft-recovery`. Draft identity combines the current vault and the stable document ID, so a rename can move the draft with the document instead of treating it as a new note.

After a reload or crash, Recovery compares the draft with the current disk state:

- If the disk still matches the draft's saved baseline, the draft can be restored into the editor.
- If the disk changed, Recovery preserves both versions for review.
- If the document moved or was deleted, Nuvyn uses stable identity and conflict records rather than guessing a path.

Draft recovery is browser-local. It is not stored in SQLite, Git, or the Docker data volume. A different browser or cleared site data cannot recover it. Individual drafts are limited to 2 MiB; cleanup limits a vault to 100 recovery records or 20 MiB of recovery content.

For server-side interruption recovery, see [Crash Recovery Architecture](../architecture/crash-recovery.md).
