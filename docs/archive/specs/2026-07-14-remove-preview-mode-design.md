# Remove Preview Mode — Design Spec

**Date:** 2026-07-14
**Status:** Approved
**Scope:** Subtract `Edit + Preview` split view; reduce view state to a 1D `edit ↔ read` toggle; bind `Cmd/Ctrl + E` shortcut.

## 1. Motivation

Nuvyn has accumulated editor-centric affordances — Monaco, Wiki Link, Link Index, Git History, AI edit, Tabs, Command Palette, Scroll Sync — that point at a **"Markdown IDE"** identity, not a Markdown viewer. The current three-option ViewModeMenu (`Edit | Edit + Preview | Read`) carries a Preview pane whose value is shrinking: its rendering is nearly identical to Reading, but it doubles the maintenance surface (split DOM, scroll-sync composable, preview scrollbar, preview lifecycle, preview cache). Removing Preview collapses the 2D `viewMode × previewOpen` state matrix into a single 1D `viewMode` axis and makes Reading the **only HTML render surface** in the app.

Reading polish and a future Present mode are explicitly out of scope for this spec.

## 2. Goals & Non-Goals

### Goals

- Delete all Preview-specific code, state, UI, and shortcuts.
- Replace the three-option `ViewModeMenu` with a single toggle button in the NavBar.
- Bind `Cmd/Ctrl + E` to switch between `edit` and `read`.
- Preserve Reading behavior byte-for-byte (TOC, heading anchors, scroll-spy, wiki-link clicks, mermaid/markmap mount).
- Keep `viewMode` persisted to `localStorage`; silently migrate users with old `previewOpen: true` layouts.

### Non-Goals

- Reading typography/spacing polish (separate spec).
- Present/Slideshow mode (separate spec).
- Renaming `MarkdownTestView`.
- Any change to the markdown rendering pipeline (`lib/markdown.ts`, `useMarkdownRender`, `useMarkmapMount`, `useMermaidMount`).

## 3. Architecture

### Before

```
viewMode:    'edit' | 'read'           (App.vue, localStorage)
previewOpen: boolean                   (useVaultLayout, localStorage)
                ↓                              ↓
        ┌───────────────────────────────────────┐
        │   2×2 matrix: edit / edit+preview / read  │
        └───────────────────────────────────────┘
                  ↓                ↓
              EditorPane         RenderedMarkdown(mode="preview"|"reading")
              PreviewPane            ↓
              useEditorPreviewScrollSync    ReadingPane + TocState
```

### After

```
viewMode:    'edit' | 'read'           (App.vue, localStorage)  ← single axis
                ↓
        ┌──────────────────┐
        │  1D edit ↔ read toggle │
        └──────────────────┘
                ↓
     ┌──────────┴──────────┐
     ↓                     ↓
EditorPane            RenderedMarkdown (no mode prop; .article always carries .reading)
(Monaco)              ReadingPane + TocState
```

Three structural consequences:

1. **Single HTML render surface.** `ReadingPane` is the only consumer of `RenderedMarkdown`, `useMarkdownRender`, mermaid, markmap, wiki-link click handling. The `mode` prop on `RenderedMarkdown` is deleted.
2. **No "split" state.** There is no longer a way to view the editor and a preview pane side by side. Edit and Read are mutually exclusive surfaces in the same pane slot.
3. **No scroll-sync code path.** `useEditorPreviewScrollSync` is deleted; the editor's `register-scroll` / `unregister-scroll` / `scroll-change` events and `setScrollFraction` / `getScrollEl` exposures are deleted.

## 4. State Changes

### 4.1 `viewMode` (preserved)

`App.vue:42-60` is unchanged:
- `viewMode: Ref<'edit' | 'read'>`
- `setViewMode(mode)`, `toggleViewMode()`
- `provide(VaultViewModeKey, ...)`
- `localStorage['nuvyn.vault.viewMode']`

### 4.2 `previewOpen` axis (removed)

Deleted from `useVaultLayout.ts`:
- `VaultLayout.previewOpen: boolean` (`:42`)
- `_previewOpen = ref(false)` (`:81`)
- default `previewOpen: false` in `VaultLayout` (`:54`)
- serializer read/write branches for `previewOpen` (`:144-153, :185-187`)
- exposed `previewOpen` ref (`:204`)
- `togglePreview()` action (`:269-276`)
- returned `previewOpen` and `togglePreview` fields (`:285, :291`)

**Migration:** persisted layouts containing a `previewOpen` field are forward-compatible because the serializer drops unknown fields on read, and the writer no longer emits the field. No explicit migration task is needed.

### 4.3 Keyboard shortcut

In `useEditorShortcuts.ts`:
- **Delete** the `Cmd+\` block that calls `togglePreview()` (`:27-30`).
- **Add** the `Cmd/Ctrl + E` block:

  ```ts
  if ((isMeta ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey
      && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    options.toggleViewMode?.()
    return
  }
  ```

- macOS uses `metaKey`; other platforms use `ctrlKey` (matches existing `Cmd+S` handling, which already uses an `isMeta` helper defined in the same file).
- Bound at `window` level by the existing shortcut manager so it works regardless of focus, but the manager already short-circuits when a modal is open.
- `options.toggleViewMode` is optional and `try/catch`-guarded: a missing callback logs a dev-only warning and does nothing.

### 4.4 Plumbing for `toggleViewMode`

`useEditorTabs.ts` currently accepts `togglePreview: () => void` as a parameter (`:32, :92`). Replace this with `toggleViewMode: () => void`:
- `useEditorTabs(options: { toggleViewMode?: () => void; ... })`
- `VaultView.vue:128` passes `viewModeApi.toggle` wrapped to match the signature.

## 5. UI Changes

### 5.1 Delete `ViewModeMenu.vue`

The three-option popover is replaced by a single button. The component file and its test file are deleted.

### 5.2 NavBar toggle button

In `NavBar.vue` at the location of the current `<ViewModeMenu>` (`:112-117`), insert:

```vue
<button
  class="view-toggle"
  :class="{ 'is-read': isReadMode }"
  :aria-label="isReadMode ? 'Switch to edit' : 'Switch to read'"
  :title="isReadMode ? 'Switch to edit (Cmd/Ctrl+E)' : 'Switch to read (Cmd/Ctrl+E)'"
  data-testid="view-toggle"
  @click="viewModeApi?.toggle()"
>
  <component :is="isReadMode ? ICON_EDIT : ICON_READ" />
</button>
```

- `viewModeApi` is already injected at `:35-36` via `VaultViewModeKey`.
- `isReadMode` is already a computed in the component.
- Icons: use existing `ICON_READ` and `ICON_EDIT` exports from `src/components/vault/icons.ts`. If `ICON_EDIT` does not exist, add it next to the existing icons in the same file (a pencil/edit glyph is appropriate; do not introduce a new icon set).
- `data-testid="view-toggle"` is for E2E selector stability.
- The button fades between the two icons with a 120 ms opacity transition (reuses the project's existing transition variables — no new values).
- Hover title advertises the `Cmd/Ctrl+E` shortcut.

### 5.3 Comment blocks

- `NavBar.vue:29-66` (header block describing the 2×2 matrix and stale `Cmd-Shift-R` claim) is rewritten to describe the new single button.
- The `Cmd-Shift-R` comment in `ViewModeMenu.vue` disappears with the file.

## 6. File Inventory

### 6.1 Whole-file deletions

| Path | Reason |
|---|---|
| `src/components/vault/PreviewPane.vue` | Preview's only component |
| `src/composables/vault/useEditorPreviewScrollSync.ts` | Preview's only composable |
| `src/composables/vault/useEditorPreviewScrollSync.test.ts` | Companion test |
| `src/views/EditorTestView.vue` | Dev-only preview test rig |
| `e2e/editor.spec.ts` | Scroll-sync E2E |
| `src/components/ViewModeMenu.vue` | Three-option popover |
| `src/components/__tests__/ViewModeMenu.test.ts` | Component's test |

### 6.2 Edit-existing files

| Path | Change |
|---|---|
| `src/views/VaultView.vue` | Drop `useEditorPreviewScrollSync` import (`:7`); drop `previewOpen, togglePreview` from `useVaultLayout()` destructure (`:73-86`); pass `toggleViewMode` (not `togglePreview`) to `useEditorTabs` (`:128`); drop `useEditorPreviewScrollSync` instantiation (`:185-189`); replace the `<div v-else-if="!isReadMode">` editor+preview split (`:316-368`) with a single `<EditorPane>` mount (no `<PreviewPane>`, no `splitter-mid`, no `contentStyle` ratio); drop the `@scroll-change` wiring (`:337`); drop the "Large document" notice (`:364`). |
| `src/components/vault/EditorPane.vue` | Drop `register-scroll` / `unregister-scroll` / `scroll-change` emits (`:43-50`); drop `editor.onDidScrollChange` handler (`:405-411`); drop all `emit('register-scroll', ...)` / `emit('unregister-scroll', ...)` call sites (`:519, :528, :554, :571`); drop `setScrollFraction` (`:565-569`); drop `getScrollEl` exposure (`:575`). |
| `src/components/vault/ReadingPane.vue` | Drop `mode="reading"` from the `<RenderedMarkdown>` tag. |
| `src/components/vault/RenderedMarkdown.vue` | Drop `mode: 'preview' \| 'reading'` prop (`:13`); simplify `:class` to a static `'article reading'` (`:51`); update header comment. |
| `src/components/NavBar.vue` | Rewrite header comment (`:29-66`); drop `useVaultLayout().previewOpen / togglePreview` plumbing (`:57-66`); replace `<ViewModeMenu>` (`:112-117`) with the toggle button from §5.2. |
| `src/composables/vault/useVaultLayout.ts` | All deletions in §4.2. |
| `src/composables/vault/useEditorTabs.ts` | Replace `togglePreview` parameter with `toggleViewMode` (`:32, :92`). |
| `src/composables/vault/editor-tabs/useEditorShortcuts.ts` | Delete `Cmd+\` (`:27-30`); add `Cmd+E` per §4.3. |
| `src/composables/vault/editor-tabs/useEditorShortcuts.test.ts` (if present) | Add unit cases per §7.1 (`Cmd+E` and `Ctrl+E` invocation; modal-open short-circuit; missing-callback warning). |
| `src/router/index.ts` | Delete `/__editor-test` route (`:5`). |
| `src/views/MarkdownTestView.vue` | Drop `mode === 'preview'` branch (`:74-76`); keep `?mode=reading`; drop preview-related CSS (`:86, :90-94`). |

### 6.3 CSS deletions

`src/style.css`:
- `:2135-2151` — `.preview-pane` flex + `.preview-pane > .article`
- `:2378-2388` — `.vault .preview-pane` and `.vault .preview-pane .article`
- `:2326-2360` — `:where(.preview-pane, .reading-pane)` → `.reading-pane`
- `:1993-2000` — "editor/preview split" comment rewrite
- `:3528-3660` — `.view-mode-menu*` rules (popover gone)

### 6.4 Test edits

- `src/composables/vault/__tests__/useEditorTabs.test.ts:649-668` — drop `Cmd+\` case
- `src/composables/vault/__tests__/useEditorTabs.test.ts:83-95, :208, :1054-1056` — drop `togglePreview` parameter plumbing
- `src/components/vault/__tests__/MonacoEditorPane.test.ts:330` — drop `previewPane.className = 'preview-pane'` setup
- `e2e/markdown-visual.spec.ts:3-17` — drop preview-wrapper case
- `e2e/view-mode.spec.ts` — **new file** covering the new toggle behavior (§7.2)
- `src/composables/vault/editor-tabs/useEditorShortcuts.test.ts` — **additions** for `Cmd+E`, `Ctrl+E`, modal-open short-circuit, and missing-callback cases (§7.1). Skip additions gracefully if the file does not yet exist.
- `useVaultLayout.test.ts` — drop `previewOpen` cases; add "serializer ignores unknown fields" case

## 7. Test Strategy

### 7.1 Unit (vitest)

- `Cmd+E` → `toggleViewMode` invoked once
- `Ctrl+E` (non-macOS) → `toggleViewMode` invoked once
- `Cmd+Shift+E` → not handled (reserved)
- `Cmd+E` while a modal is open → not handled
- `useVaultLayout` serializer: payload with extra `previewOpen: true` field is read back without that field

### 7.2 E2E (playwright, new `e2e/view-mode.spec.ts`)

- App opens in `edit` mode by default
- Click NavBar toggle → enters `read` mode; toggle button now shows the "edit" icon
- Click again → back to `edit`
- `Cmd+E` from the editor → toggles mode
- After a hard refresh, the last-selected mode is restored
- In `read` mode, TOC still works; clicking a heading scrolls; clicking a wiki-link navigates
- In `edit` mode, Monaco is mounted and accepts input

### 7.3 Regression

- Full `pnpm test` — confirm Reading TOC, heading anchors, mermaid, markmap, wiki-link still pass
- Full `pnpm test:e2e` — confirm reading interactions still pass
- `pnpm typecheck` — clean

## 8. Verification Commands

The PR is complete when all of these return success or empty:

```sh
pnpm typecheck
pnpm test
pnpm test:e2e

grep -r "previewOpen" src/                 # expect: empty
grep -r "togglePreview" src/                # expect: empty
grep -r "\bPreviewPane\b" src/              # expect: empty
grep -r "Cmd+\\\\" src/                     # expect: empty (Cmd+\ shortcut gone)
grep -r "ViewModeMenu" src/                 # expect: empty
grep -r "useEditorPreviewScrollSync" src/   # expect: empty
grep -r "EditorTestView" src/               # expect: empty
```

## 9. Risk & Rollout

- **Risk:** some users may have `Cmd+\` muscle memory. Mitigation: nothing — the menu already exposes toggle via UI, and `Cmd+E` is a discoverable shortcut with a hover hint.
- **Risk:** stale `previewOpen` in `localStorage` could trigger serializer warnings. Mitigation: the serializer already drops unknown fields silently; we do not change the serializer contract.
- **Rollout:** single PR. No feature flag. Reading is fully functional; the only user-visible change is the disappearance of the split-pane option and the appearance of the single toggle button.

## 10. Open Questions

None at design time. Reading typography polish and Present mode are tracked as separate future specs.
