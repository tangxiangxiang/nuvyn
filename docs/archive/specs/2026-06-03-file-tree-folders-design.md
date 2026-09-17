# File-Tree Folder Support — Design

> **For agentic workers:** This is a design spec. Next step is the implementation plan under `docs/superpowers/plans/`.

**Goal:** Add real nested-folder support to the vault's `FileTree`: folders are first-class on disk, rendered as a recursive disclosure tree, drag-and-drop moves files between folders, and the URL/route/breadcrumb/tabs all carry the full path.

**Architecture:** Server is the source of truth for the filesystem. Two read endpoints (`/api/tree` for the file-tree UI, `/api/posts` for everything else) plus per-resource CRUD endpoints. The `path` field is relative to `src/content/`, always begins with `posts/`, and replaces the old `slug` field. Vue Router uses a `*` pathMatch splat so URLs of any depth work. The FileTree component becomes recursive via a new `TreeRow` child component. Drag-and-drop uses native HTML5 DnD with the folder row as the drop target.

**Tech Stack:** Vue 3 `<script setup>`, vue-router `pathMatch(.*)*`, native HTML5 Drag and Drop, Hono backend with `fs/promises`, single global `style.css`. No new dependencies.

---

## 1. Data model

### Path convention

- A `path` is the file's location **relative to `src/content/`**, always beginning with `posts/`, with `/` as segment separator, no leading or trailing slash, no `.md` suffix.
- Disk layout: `src/content/posts/notes/draft.md` → `path: "posts/notes/draft"`.
- Top-level file: `path: "posts/hello-world"`.
- Folder: `path: "posts/notes"` (no trailing slash).

### Validation regex

Each segment: `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`

Full path regex (must start with `posts/`, allow zero or more nested segments):

```
^posts/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?/)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$
```

`assertSafePath(p)` additionally resolves the candidate disk path with `path.resolve(CONTENT_DIR, p)` and verifies it is still inside `CONTENT_DIR` (rejects `..` and absolute paths even if the regex somehow let them through).

### Types — `src/lib/api.ts`

```ts
export interface PostSummary {
  path: string           // replaces slug; e.g. "posts/hello-world" or "posts/notes/draft"
  title: string
  date: string
  tags: string[]
  summary?: string
  size: number
  mtime: number
}

export type TreeNode =
  | { kind: 'file';   name: string; path: string; title: string; mtime: number }
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
```

`Tab` in [src/components/vault/tabs.ts](../../../src/components/vault/tabs.ts): rename `slug` → `path` throughout.

### Backwards compatibility

The four existing files (`hello-world.md`, `markdown-syntax.md`, `typescript-utility-types.md`, `vue3-tips.md`) become `path: "posts/<name>"` automatically — they are top-level files under `posts/`. Zero data migration.

---

## 2. Backend API

### Endpoint inventory

| Method | Path                        | Purpose                                | Body / Query                             | Returns                              |
| ------ | --------------------------- | -------------------------------------- | ---------------------------------------- | ------------------------------------ |
| GET    | `/api/tree`                 | File tree (recursive)                  | —                                        | `TreeNode[]`                         |
| GET    | `/api/posts`                | Flat list of files                     | —                                        | `PostSummary[]`                      |
| GET    | `/api/posts/*`              | Read one post (raw + frontmatter)      | —                                        | `{ path, raw, frontmatter, ... }`    |
| POST   | `/api/posts`                | Create file                            | `{ path, title? }`                       | `PostSummary`                        |
| PATCH  | `/api/posts/*`              | Rename or move a file                  | `{ name?: string, targetPath?: string }` | `PostSummary`                        |
| DELETE | `/api/posts/*`              | Delete a file                          | —                                        | `{ ok: true }`                       |
| POST   | `/api/folders`              | Create empty folder                    | `{ path }`                               | `{ path }`                           |
| PATCH  | `/api/folders/*`            | Rename folder (cascades)               | `{ newPath }`                            | `{ path, moved: string[] }`          |
| DELETE | `/api/folders/*`            | Recursive delete                       | `?recursive=true` (required)             | `{ deleted: string[] }`              |

### Path-to-disk mapping

```ts
const CONTENT_DIR = path.resolve(process.cwd(), 'src/content')
const POSTS_DIR   = path.join(CONTENT_DIR, 'posts')

function filePathFor(p: string)   { return path.join(CONTENT_DIR, p + '.md') }
function folderPathFor(p: string) { return path.join(CONTENT_DIR, p) }
```

All splat endpoints use Hono's `*` route; the path after the prefix becomes the `path` field. Example: `PATCH /api/posts/notes/draft` → `path = "posts/notes/draft"`.

### Behavior contracts

- **`POST /api/posts`**: auto-creates missing parent directories via `fs.mkdir(..., { recursive: true })`. Returns 409 if file already exists.
- **`PATCH /api/posts/*`**: exactly one of `name` / `targetPath` must be set. `name` renames within the same folder; `targetPath` moves to a new location (may also rename). 409 if destination exists. 422 if `targetPath` resolves to a location inside the source's own subdirectory (cycle).
- **`PATCH /api/folders/*`**: `newPath` is a full `path` value, but the parent must match the current parent — only the last segment may differ (single-segment rename; avoids ambiguity in cascade). Atomic on disk via `fs.rename` of the whole directory. Returns `moved: string[]` of all file `path` values that were renamed under the hood, so the client can refresh stale references in one round-trip.
- **`DELETE /api/folders/*`**: returns 400 if `?recursive=true` is missing and the folder is non-empty. With `?recursive=true`, deletes all contents and the folder itself, returning `deleted: string[]`.
- **All endpoints**: validate via `assertSafePath` first; on failure return 400 with `{ error: 'invalid path' }`.

### Error codes

- 400: invalid path / missing `?recursive=true`
- 403: resolved path escapes `CONTENT_DIR`
- 404: file or folder not found
- 409: destination already exists
- 422: move target is a descendant of the source

---

## 3. Frontend architecture

### Router — `src/router/index.ts`

```ts
{
  path: '/vault',
  component: VaultView,
  children: [
    { path: '',                  name: 'vault',      component: VaultView },
    { path: ':pathMatch(.*)*',   name: 'vault-doc',  component: VaultView },
  ],
}
```

`VaultView` derives the current path from `route.params.pathMatch`:

```ts
const routePath = computed<string | null>(() => {
  const m = (route.params.pathMatch as string[] | undefined) ?? []
  return m.length ? 'posts/' + m.join('/') : null
})
```

URL examples:

- `/vault` → no file open
- `/vault/hello-world` → `path: "posts/hello-world"`
- `/vault/notes/draft` → `path: "posts/notes/draft"`

### VaultView state

No new state library. `VaultView` holds:

```ts
const tree        = ref<TreeNode[]>([])     // from /api/tree
const posts       = ref<PostSummary[]>([])  // from /api/posts
const currentPath = computed(() => routePath)
```

All tab operations (`openTab`, `closeTab`, `saveCurrentTab`, …) keyed by `path` instead of `slug`. `Tab.path` becomes the canonical identity.

### FileTree — recursive via `TreeRow`

The flat `FileTree.vue` template becomes:

```vue
<template>
  <ul class="tree" role="tree">
    <TreeRow
      v-for="node in tree"
      :key="node.path"
      :node="node"
      :depth="0"
      :current-path="currentPath"
      :expanded="expanded.has(node.path)"
      @toggle="toggle"
      @select="emit('select', $event)"
      @rename="onRename"
      @delete="onDelete"
      @move="onMove"
    />
  </ul>
</template>
```

`TreeRow.vue` is a new file: when its node is a folder, it renders an inner `<ul class="tree-children">` containing more `TreeRow` children with `depth + 1`. The row itself contains the chevron, icon, name, optional date, and hover-revealed actions.

Indent uses a CSS variable: `padding-left: calc(8px + var(--depth) * 12px)`.

### Top-of-tree controls

The header is split into two buttons:

- **+ New Post** — creates a file in the active folder (or root if no file is open)
- **+ New Folder** — creates a folder in the active folder (or root)

Both use a small `promptDialog` (modeled on `useConfirm`) instead of `window.prompt`, so it can be styled and is dismissable. The dialog asks for a name (single segment, no path); the caller composes the full `path` from the active context.

### Folder-row actions (on hover)

- **New file in here** / **New folder in here** — sets the active folder for the next create
- **Rename** — inline edit on the folder name (single segment only)
- **Delete** — `useConfirm` with "X items inside will also be deleted" copy when non-empty; on confirm, `DELETE /api/folders/<path>?recursive=true`

### File-row actions (unchanged shape)

- **Rename** — inline edit on the file name (single segment only)
- **Delete** — `useConfirm` then `DELETE /api/posts/<path>`

### Expansion state

New localStorage key: `nuvyn.vault.expandedPaths` (JSON array of folder paths).

- On mount: `expanded = ref(new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]')))`
- On toggle: update ref, write to storage.
- **Default-on-open**: when a new `currentPath` is set, walk up its ancestors and add each to `expanded` (idempotent if already present). This makes opening a file inside a folder show it without extra clicks.

### Drag-and-drop

Native HTML5 DnD.

| Surface              | `draggable` | `dragstart`                                           | `dragover`              | `drop`                                |
| -------------------- | ----------- | ----------------------------------------------------- | ----------------------- | ------------------------------------- |
| File row             | true        | `dataTransfer.setData('text/x-nuvyn-path', node.path)` | (browser default)       | (none)                                |
| Folder row           | true        | same                                                  | `e.preventDefault()`    | compute new path → `PATCH`            |
| Root area            | false       | —                                                     | `e.preventDefault()`    | move to root (drop last segment)      |

Visual states:
- Source row during drag: `.dragging` class → `opacity: 0.4`
- Folder row as drop target: `.drop-target` class → `outline: 1px dashed var(--accent)`
- Root area as drop target: `.drop-target-root` class on `<aside class="file-tree">` → highlighted top border

On drop:
1. Call `PATCH /api/posts/<srcPath>` with `targetPath: "<parent>/<name>"` (or no parent for root).
2. If 422 (cycle): show toast "Cannot move a folder into itself".
3. If 409: show toast "Destination already exists".
4. On success: refresh `tree` and `posts` from server.
5. If the moved file was the current tab: update the URL via `router.replace`.

**Out of scope for this iteration:** dragging folders (only files can be moved via DnD; folder reorder via DnD is a future enhancement).

### Breadcrumb — `src/components/vault/Breadcrumb.vue`

```vue
<template v-if="currentPath">
  <a class="seg" @click="goRoot">posts</a>
  <template v-for="(seg, i) in segments" :key="i">
    <span class="sep">/</span>
    <a v-if="i < segments.length - 1" class="seg" @click="goTo(i)">{{ seg }}</a>
    <span v-else class="seg current">{{ seg }}</span>
  </template>
  <span v-if="isFile">.md</span>
</template>
<template v-else>posts</template>
```

`segments` is `currentPath!.split('/').slice(1)` (drops the `posts/` prefix). Each intermediate segment links to `/vault/<segments.slice(0, i+1).join('/')>`. The leaf segment is plain text.

### TagPanel, CommandPalette, search

- **TagPanel**: continues to use the flat `posts` list; no structural change. Each result shows the file's path segments after the `posts/` prefix (e.g. `notes / draft` for a nested file).
- **CommandPalette**: same; result rendering includes the path for clarity.
- **`lib/search.ts`**: the `SearchDoc` adds a `path` field; the search index is updated when files are renamed/moved.

### `promptDialog` — new lightweight primitive

`src/composables/usePrompt.ts`, modeled on [src/composables/useConfirm.ts](../../../src/composables/useConfirm.ts). Signature:

```ts
const { prompt } = usePrompt()
const value = await prompt({ title: 'New post', placeholder: 'filename' })
```

A `PromptHost.vue` component, sibling to `ConfirmHost.vue` and `ToastHost.vue`, renders the active prompt.

---

## 4. Styling

All new rules go into the existing vault-scoped block in [src/style.css](../../../src/style.css) (around lines 447-521). Generic block (lines 803-896) gets a parallel update or, if not visible on the active page, can be left for a follow-up.

```css
.vault .file-tree .tree { list-style: none; padding: 0; margin: 0; overflow-y: auto; flex: 1; }
.vault .file-tree .tree-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 8px 3px calc(8px + var(--depth, 0) * 12px);
  cursor: default; user-select: none; border-radius: 3px; position: relative;
}
.vault .file-tree .tree-row:hover { background: var(--row-hover); }
.vault .file-tree .tree-row.active { background: var(--row-active); }
.vault .file-tree .tree-row[draggable] { cursor: grab; }
.vault .file-tree .tree-row.dragging { opacity: 0.4; }
.vault .file-tree .tree-row.drop-target {
  outline: 1px dashed var(--accent); outline-offset: -1px;
  background: var(--row-drop);
}
.vault .file-tree .tree-children { list-style: none; padding: 0; margin: 0; }
.vault .file-tree .chevron {
  width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-mute); transition: transform 120ms;
}
.vault .file-tree .tree-row.expanded > .chevron { transform: rotate(90deg); }
.vault .file-tree .row-icon { width: 14px; height: 14px; flex-shrink: 0; }
.vault .file-tree .row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vault .file-tree .row-date { font-size: 0.7rem; color: var(--text-mute); }
.vault .file-tree .row-actions { opacity: 0; display: flex; gap: 2px; }
.vault .file-tree .tree-row:hover .row-actions { opacity: 1; }
.vault .file-tree.drop-target-root { box-shadow: inset 0 2px 0 0 var(--accent); }
```

### Icons

Three new inline SVG strings, 14×14, `viewBox="0 0 16 16"`, `stroke-width="1.5"`, matching the line weight of [src/components/vault/ActivityBar.vue](../../../src/components/vault/ActivityBar.vue):

- `icon-folder` — closed folder
- `icon-folder-open` — open folder
- `icon-file-md` — sheet of paper with a folded corner

Exported from a new `src/components/vault/icons.ts` for reuse.

The existing `--vs-` token series provides `--accent`, `--row-hover`, `--row-active`, `--text-mute` — all already defined. No new color tokens required.

---

## 5. Error handling

| Scenario                          | Frontend behavior                                                              |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Invalid path (server 400)         | Toast: "Invalid path"                                                           |
| Path escape (403)                 | Toast: "Cannot access outside content directory"                                |
| Not found (404) on open           | Toast + if it was the current file, `router.replace('/vault')`                  |
| Destination exists (409)          | Toast: "Destination already exists"                                             |
| Move into self/descendant (422)   | Toast: "Cannot move a folder into itself"                                       |
| Recursive delete unconfirmed (400)| `useConfirm` dialog with item count, then retry with `?recursive=true`          |
| Network error                     | Toast: "Network error, try again"; no local state change                        |
| PATCH on current file moves it    | `router.replace` to the new path so the URL stays consistent                    |
| File renamed via PATCH            | All `Tab` instances with the old `path` are updated in place; URL is replaced   |

### Update strategy

All mutations are **server-first**: call the API, on success refresh the affected slice of `tree` and `posts` (cheaper than a full re-fetch and keeps scroll position). On error, do not touch local state.

---

## 6. Migration

- **Source code**: rename `slug` → `path` throughout; update regex; replace `slug` parameter on the API surface; update router, store, types, tests.
- **Disk**: no changes required. The four existing `.md` files already have `path: "posts/<filename>"` semantics under the new convention.
- **localStorage**: the new `nuvyn.vault.expandedPaths` key starts empty; users get a default-collapsed tree on first open of the new version. Their `nuvyn.vault.layout` and `nuvyn.theme` keys are untouched.

---

## 7. Out of scope (YAGNI)

- Drag-and-drop of folders (only files can be dragged into folders)
- Multi-select / bulk operations
- Soft delete / trash / undo
- Folder icon color customization
- Nested-depth UI limit (no enforced cap; design holds at any depth)
- SSR story (this remains a client-only Vite app)
- File watching / external file system changes (the tree is refreshed only on app actions, not on disk events)
- "Move folder" via the action menu (folder rename is single-segment only; full folder moves are out of scope for this iteration)

---

## 8. Files to change

**Create**
- [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue) — recursive row component
- [src/components/vault/icons.ts](../../../src/components/vault/icons.ts) — inline SVG strings
- [src/components/PromptHost.vue](../../../src/components/PromptHost.vue) — styled prompt dialog host
- [src/composables/usePrompt.ts](../../../src/composables/usePrompt.ts) — `prompt()` API
- `server/__tests__/paths.test.ts` — `assertSafePath` unit tests (new test file, no test framework installed yet)
- `src/components/vault/__tests__/FileTree.test.ts` — recursive rendering, expand/collapse, drag emit (new test file)

**Modify**
- [server/index.ts](../../../server/index.ts) — new regex, new helpers, new endpoints
- [src/lib/api.ts](../../../src/lib/api.ts) — `PostSummary.path`, new `TreeNode`, new client helpers
- [src/components/vault/tabs.ts](../../../src/components/vault/tabs.ts) — `Tab.path`
- [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) — replace flat `<ul>` with `<TreeRow>` recursion
- `src/components/vault/Breadcrumb.vue` — dynamic path
- [src/components/vault/CommandPalette.vue](../../../src/components/vault/CommandPalette.vue) — show path in results
- [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue) — show path segments under each result
- [src/lib/search.ts](../../../src/lib/search.ts) — index `path`
- [src/views/VaultView.vue](../../../src/views/VaultView.vue) — derive `currentPath` from `pathMatch`, replace slug-based state
- [src/router/index.ts](../../../src/router/index.ts) — splat route
- [src/App.vue](../../../src/App.vue) — mount `PromptHost`
- [src/style.css](../../../src/style.css) — new tree styles, drop-target styles

---

## 9. Testing / verification

The project currently has no test framework. Add Vitest as a dev dependency in this PR, then:

1. **Unit — `assertSafePath`**: covers valid top-level, valid nested, rejection of `..`, absolute paths, empty segments, invalid characters, non-`posts/` prefix.
2. **Unit — `listPosts` / tree builder**: given a mock directory, asserts `PostSummary[]` and `TreeNode[]` shape; sorts folders before files; handles empty directories.
3. **Component — `FileTree` rendering**: renders 1- and 2-level deep trees; chevron toggles; active row highlighting; drag emits correct events.
4. **Integration — API endpoints** (with `fs` mocked): create/move/delete file; create/move/delete folder; cascade rename; recursive delete; error responses (400/403/404/409/422).
5. **Build**: `npm run build` passes (`vue-tsc` + `vite`).
6. **Manual checklist** (in the plan):
   - Create a file at root → appears, opens, URL is `/vault/<name>`.
   - Create a folder at root → appears, expands, URL unchanged.
   - Create a file inside a folder → appears nested, opens, URL is `/vault/<folder>/<name>`.
   - Rename a file → URL updates, tab identity preserved.
   - Rename a folder → all children stay functional, breadcrumbs update.
   - Drag a file into a folder → moves on disk, breadcrumb updates, tab URL updates.
   - Drag a file out to root → moves to top level.
   - Delete a folder with contents → confirm dialog with item count, then all gone.
   - Refresh browser mid-session → state restored from `localStorage`, current file opens at the right URL.
   - Light + dark themes still render correctly in the new tree.

---

## 10. Implementation order (for the plan)

1. **Backend first**: new regex, `assertSafePath`, `filePathFor`/`folderPathFor`, then `/api/tree` and updated `/api/posts` and `/api/posts/*`. Verify with a curl script.
2. **Folder endpoints**: `POST /api/folders`, `PATCH /api/folders/*` (cascade), `DELETE /api/folders/*` (recursive).
3. **Type updates**: `PostSummary.path`, `TreeNode`, `Tab.path`, `lib/api.ts` client helpers.
4. **Router + VaultView path derivation**: splat route, `currentPath` computed, all `slug` references rewritten.
5. **`PromptHost` + `usePrompt`**: small, isolated, no other code depends on it yet but the file-tree UI will.
6. **`TreeRow.vue` + new `FileTree.vue`**: recursive component, depth indentation, expand/collapse.
7. **DnD wiring**: file row drag source, folder drop target, root drop target, `PATCH` on drop, refresh.
8. **Top-bar buttons**: `+ New Post`, `+ New Folder`, with prompt dialog.
9. **Breadcrumb update**: dynamic segments, click navigation.
10. **TagPanel / CommandPalette / search**: show path in result rows.
11. **Style.css**: all tree rules, drop-target states, indent variables.
12. **Expansion persistence**: localStorage round-trip, default-expand ancestors of current path.
13. **Full manual verification** per the checklist.
