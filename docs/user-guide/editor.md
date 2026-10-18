# Editor and Draft Recovery

## Editing

Nuvyn uses Monaco for Markdown source editing and a separate Read mode for rendered output. There is no split Preview mode. Use the navigation-bar toggle to switch modes.

### Images in Notes

Use the existing **Insert image** control, drag a local image into the editor, or paste a local image file when the clipboard provides one. Nuvyn uploads it to the Vault and inserts a Markdown image reference; PNG, JPEG, WebP, GIF and AVIF keep their existing behavior.

Static SVG files are supported up to 8 MiB. SVG is validated on the server before storage and again when read, so scripts, event handlers, remote resources, animation, arbitrary HTML, and unsupported CSS are rejected. Common static vectors, text, internal gradients/clipping, and bounded Excalidraw WOFF2 fonts and raster embeds are supported. Excalidraw exports containing unsupported features such as SVG filters may be rejected; the file is not silently converted to PNG. Raw inline `<svg>` markup is still not allowed in Markdown.

## Document Export

### Export from File Tree

Right-click an ordinary Note in the File Tree and choose **导出…** / **Export…**. Select **Markdown (.md)** or **PDF (.pdf)**, then choose **Export**. Folders do not have this action. Press Escape or Cancel to close the format chooser; focus returns to the selected tree item.

Document export is available only from the File Tree context menu. It does not add controls to the reading or editing surface. Managed Diary documents retain their existing **Export PDF** action and do not offer Markdown export; Diary access must remain unlocked during the export.

### Markdown: original source

Markdown downloads a single UTF-8 `.md` file. It preserves the source text, including Frontmatter, original line endings, Flex, Callouts, Mermaid/MarkMap fences, math, WikiLinks, Include/Snippet directives, image references and Board references. Export does not render, expand or reformat these constructs.

The filename comes from the original file basename, not the document's display title. An existing `.md` extension is not duplicated. Unsafe filename characters are replaced, reserved device names are prefixed, and very long names are limited to 200 UTF-8 bytes before the extension without splitting Unicode characters.

**Images, attachments, Include targets, Board scenes and other referenced files are not bundled.** This is not a Vault backup. Nuvyn-specific syntax may require Nuvyn or a compatible renderer. Offline self-contained HTML export is planned for V2.2 and is not available in this version.

### PDF: rendered document

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

For both formats, if the selected document is open and loaded successfully, export uses that document's current live editing buffer, including unsaved edits. You do not need to save first. Export does not force a save, change the dirty state, or create a Git commit. Each export captures one immutable source snapshot; later edits do not change an export already in progress.

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

Only one document export can run at a time. While exporting, duplicate submission is disabled. No additional export is queued.

If an export fails, Nuvyn ends the transaction and removes any temporary export surface. The format chooser remains available for retry. The document and workspace remain unchanged. The existing Diary PDF action retains its existing error handling.

Each open document has its own workspace tab and unsaved buffer. Useful shortcuts include:

| Action | Shortcut |
| --- | --- |
| Save now | `Ctrl+S` / `Command+S` |
| Close active tab | `Ctrl+W` / `Command+W` |
| Open command palette | `Ctrl+P` / `Command+P` |
| Toggle Files panel | `Ctrl+B` / `Command+B` |

## Zen Mode

On an open Note or unlocked Diary document, use `Ctrl/Cmd+K` followed by `Z` to toggle Zen Mode. You can also enter it without a visible control: hover over the Nuvyn Logo for three seconds with a mouse, or long-press the Logo for three seconds on a phone or tablet. After the Logo constellation finishes, the surrounding workspace fades away. A normal tap or click on the Logo still opens the home page.

Press `Escape` or use the keyboard shortcut again to leave Zen Mode. The editor, reading mode, unsaved drafts, and Diary session remain the same; refreshing the page returns to the regular workspace layout.

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
