# Remove Preview Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Edit+Preview split view, collapse the viewMode × previewOpen state matrix into a 1D `edit ↔ read` toggle, and bind `Cmd/Ctrl + E` as the new toggle shortcut.

**Architecture:** Subtract Preview-only code, state, and UI. The single `viewMode: 'edit' | 'read'` axis becomes the only view state. `Cmd/Ctrl + E` toggles between the two modes. `RenderedMarkdown` no longer carries a `mode` prop — Reading is the only HTML render surface.

**Tech Stack:** Vue 3, TypeScript, Vitest, Playwright, Monaco editor (unchanged), markdown-it (unchanged).

## Global Constraints

- macOS uses `metaKey`; other platforms use `ctrlKey` for the new `Cmd/Ctrl + E` binding (matches the existing `Cmd+S` / `Cmd+W` / `Cmd+B` handling pattern in `useEditorShortcuts.ts`, which uses `const meta = e.metaKey || e.ctrlKey`).
- The new shortcut is bound at `window` level by the existing shortcut manager; it is short-circuited when a modal is open.
- `data-testid="view-toggle"` is required on the new NavBar button for E2E selector stability.
- The `previewOpen` field in persisted layouts is silently dropped on read (the existing serializer already ignores unknown fields) and never written again. No explicit migration is required.
- All E2E selectors must use `data-testid` (no CSS-class-only selectors).
- `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` must all pass at the end.

## File Structure

### Files to delete (whole-file)

| Path | Why |
|---|---|
| `src/components/vault/PreviewPane.vue` | Preview's only component |
| `src/composables/vault/useEditorPreviewScrollSync.ts` | Preview's only composable |
| `src/composables/vault/useEditorPreviewScrollSync.test.ts` | Companion test |
| `src/views/EditorTestView.vue` | Dev-only preview test rig |
| `e2e/editor.spec.ts` | Scroll-sync E2E |
| `src/components/ViewModeMenu.vue` | Three-option popover replaced by single button |
| `src/components/__tests__/ViewModeMenu.test.ts` | Component's test |

### Files to create

| Path | Responsibility |
|---|---|
| `src/composables/vault/editor-tabs/useEditorShortcuts.test.ts` | Unit tests for `Cmd/Ctrl+E` and existing shortcuts |
| `e2e/view-mode.spec.ts` | E2E for the edit↔read toggle (mouse + keyboard + persistence) |

### Files to edit

| Path | Change |
|---|---|
| `src/composables/vault/useVaultLayout.ts` | Drop `previewOpen` axis entirely |
| `src/composables/vault/__tests__/useVaultLayout.test.ts` | Drop `previewOpen` cases; add "serializer drops unknown fields" case |
| `src/composables/vault/useEditorTabs.ts` | Rename `togglePreview` param to `toggleViewMode` |
| `src/composables/vault/__tests__/useEditorTabs.test.ts` | Rename `togglePreview` → `toggleViewMode`; replace `Cmd+\` test with `Cmd+E` test |
| `src/composables/vault/editor-tabs/useEditorShortcuts.ts` | Drop `Cmd+\`; add `Cmd+E` |
| `src/components/vault/ReadingPane.vue` | Drop `mode="reading"` from `<RenderedMarkdown>` |
| `src/components/vault/RenderedMarkdown.vue` | Drop `mode` prop; static `'article reading'` class |
| `src/components/vault/icons.ts` | Add `ICON_EDIT` next to `ICON_READ` |
| `src/components/NavBar.vue` | Replace `<ViewModeMenu>` with `<button data-testid="view-toggle">` |
| `src/views/VaultView.vue` | Drop scroll-sync usage; collapse editor+preview split to single `<EditorPane>` |
| `src/components/vault/EditorPane.vue` | Drop scroll-sync events / `setScrollFraction` / `getScrollEl` |
| `src/router/index.ts` | Drop `/__editor-test` route |
| `src/views/MarkdownTestView.vue` | Drop `?mode=preview` branch and preview CSS |
| `e2e/markdown-visual.spec.ts` | Drop preview-wrapper case (`:3-17`) |
| `src/style.css` | Drop `.preview-pane*` and `.view-mode-menu*` rules |

---

## Task 1: Remove `previewOpen` axis, rename plumbing, bind `Cmd/Ctrl + E`

**Files:**
- Modify: `src/composables/vault/useVaultLayout.ts`
- Modify: `src/composables/vault/__tests__/useVaultLayout.test.ts`
- Modify: `src/composables/vault/useEditorTabs.ts`
- Modify: `src/composables/vault/__tests__/useEditorTabs.test.ts`
- Modify: `src/composables/vault/editor-tabs/useEditorShortcuts.ts`
- Create: `src/composables/vault/editor-tabs/useEditorShortcuts.test.ts`

**Why atomic:** `useEditorTabs.togglePreview` references `useVaultLayout.togglePreview`. Removing one without the other breaks the build. `Cmd+E` is bound in the same shortcut manager as `Cmd+\` was, so they swap in one edit.

- [ ] **Step 1: Write the failing `useEditorShortcuts.test.ts`**

Create `src/composables/vault/editor-tabs/useEditorShortcuts.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'
import { useEditorShortcuts } from '../useEditorShortcuts'

function makeHarness(overrides: Partial<Parameters<typeof useEditorShortcuts>[0]> = {}) {
  const tabs = ref<Tab[]>([{ path: '/a.md', title: 'a' }])
  const activePath = ref<string | null>('/a.md')
  const doSaveNow = vi.fn(async () => {})
  const closeTab = vi.fn(async () => {})
  const selectTab = vi.fn()
  const selectFilesPanel = vi.fn()
  const toggleViewMode = vi.fn()
  const api = useEditorShortcuts({
    tabs,
    activePath,
    doSaveNow,
    closeTab,
    selectTab,
    selectFilesPanel,
    toggleViewMode,
    ...overrides,
  })
  return { ...{ tabs, activePath, doSaveNow, closeTab, selectTab, selectFilesPanel, toggleViewMode }, ...api }
}

function fireKey(key: string, init: Partial<KeyboardEvent> = {}) {
  const ev = new KeyboardEvent('keydown', { key, ...init })
  window.dispatchEvent(ev)
  return ev
}

describe('useEditorShortcuts — Cmd/Ctrl+E toggles view mode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('Cmd+E (meta) calls toggleViewMode and preventDefault()', () => {
    const h = makeHarness()
    const ev = fireKey('e', { metaKey: true })
    expect(h.toggleViewMode).toHaveBeenCalledOnce()
    expect(ev.defaultPrevented).toBe(true)
  })

  it('Ctrl+E (no meta) calls toggleViewMode', () => {
    const h = makeHarness()
    fireKey('e', { ctrlKey: true })
    expect(h.toggleViewMode).toHaveBeenCalledOnce()
  })

  it('Cmd+Shift+E does NOT call toggleViewMode (reserved)', () => {
    const h = makeHarness()
    fireKey('e', { metaKey: true, shiftKey: true })
    expect(h.toggleViewMode).not.toHaveBeenCalled()
  })

  it('Cmd+Alt+E does NOT call toggleViewMode', () => {
    const h = makeHarness()
    fireKey('e', { metaKey: true, altKey: true })
    expect(h.toggleViewMode).not.toHaveBeenCalled()
  })

  it('plain "e" (no modifier) does NOT call toggleViewMode', () => {
    const h = makeHarness()
    fireKey('e')
    expect(h.toggleViewMode).not.toHaveBeenCalled()
  })

  it('missing toggleViewMode callback does not throw and logs a dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness({ toggleViewMode: undefined })
    expect(() => fireKey('e', { metaKey: true })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('Cmd+\\ no longer triggers anything (legacy preview shortcut removed)', () => {
    const h = makeHarness()
    fireKey('\\', { metaKey: true })
    expect(h.toggleViewMode).not.toHaveBeenCalled()
    expect(h.doSaveNow).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `pnpm test -- src/composables/vault/editor-tabs/useEditorShortcuts.test.ts`
Expected: FAIL — `toggleViewMode` is not a recognized option on `useEditorShortcuts` (the existing options include `togglePreview`).

- [ ] **Step 3: Edit `useEditorShortcuts.ts` — drop `Cmd+\`, add `Cmd+E`, swap `togglePreview` → `toggleViewMode`**

Replace the entire file with:

```ts
import type { Ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'

export function useEditorShortcuts(options: {
  tabs: Ref<Tab[]>
  activePath: Ref<string | null>
  doSaveNow: () => Promise<void>
  closeTab: (path: string) => Promise<void>
  selectTab: (path: string) => void
  selectFilesPanel: () => void
  toggleViewMode?: () => void
}) {
  function onKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key === 's') {
      e.preventDefault()
      void options.doSaveNow()
    }
    if (meta && e.key === 'w' && options.activePath.value) {
      e.preventDefault()
      void options.closeTab(options.activePath.value)
    }
    if (meta && e.key === 'b') {
      e.preventDefault()
      options.selectFilesPanel()
    }
    if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      if (options.toggleViewMode) {
        options.toggleViewMode()
      } else if (import.meta.env.DEV) {
        console.warn('[useEditorShortcuts] Cmd/Ctrl+E pressed but toggleViewMode is not wired')
      }
    }
    if (meta && e.key === 'Tab' && options.tabs.value.length > 0) {
      e.preventDefault()
      const cur = options.tabs.value.findIndex((t) => t.path === options.activePath.value)
      const dir = e.shiftKey ? -1 : 1
      const nextIdx = cur === -1
        ? (dir > 0 ? 0 : options.tabs.value.length - 1)
        : (cur + dir + options.tabs.value.length) % options.tabs.value.length
      options.selectTab(options.tabs.value[nextIdx].path)
    }
  }

  return { onKeydown }
}
```

- [ ] **Step 4: Run the new test file again to verify all cases pass**

Run: `pnpm test -- src/composables/vault/editor-tabs/useEditorShortcuts.test.ts`
Expected: PASS — all 7 cases green.

- [ ] **Step 5: Edit `useEditorTabs.ts` — rename `togglePreview` parameter to `toggleViewMode`**

In `src/composables/vault/useEditorTabs.ts`, find the function signature block. The current shape is:

```ts
export function useEditorTabs(options: {
  ...
  togglePreview?: () => void
  ...
})
```

Change it to:

```ts
export function useEditorTabs(options: {
  ...
  toggleViewMode?: () => void
  ...
})
```

Then find the body that forwards `togglePreview` into `useEditorShortcuts` (currently `togglePreview: options.togglePreview` or `togglePreview: () => options.togglePreview?.()`). Change that line to:

```ts
toggleViewMode: options.toggleViewMode
```

Grep first to confirm: `grep -n "togglePreview" src/composables/vault/useEditorTabs.ts`

- [ ] **Step 6: Update `useEditorTabs.test.ts` — rename `togglePreview` → `toggleViewMode` and replace `Cmd+\` test with `Cmd+E` test**

In `src/composables/vault/__tests__/useEditorTabs.test.ts`:

1. Rename every `togglePreview` test variable to `toggleViewMode` (4 sites at lines `:79, :83, :92, :94, :1054, :1055, :1056`).
2. Replace the test at lines `:649-668` ("`onKeydown Cmd-\\ calls togglePreview (mirrors the NavBar eye-button)`") with:

```ts
it('onKeydown Cmd+E calls toggleViewMode (NavBar toggle button)', async () => {
  const h = await setupHarness()
  fireKeyDown({ metaKey: true, key: 'e' })
  await flushPromises()
  expect(h.toggleViewMode).toHaveBeenCalledOnce()

  h.toggleViewMode.mockClear()
  fireKeyDown({ ctrlKey: true, key: 'e' })
  await flushPromises()
  expect(h.toggleViewMode).toHaveBeenCalledOnce()
})
```

- [ ] **Step 7: Run `useEditorTabs` tests to verify they pass after the rename**

Run: `pnpm test -- src/composables/vault/__tests__/useEditorTabs.test.ts`
Expected: PASS.

- [ ] **Step 8: Edit `useVaultLayout.ts` — remove the `previewOpen` axis**

Open `src/composables/vault/useVaultLayout.ts` and apply the following edits in order. Each bullet is a single, verifiable removal.

1. In the `VaultLayout` interface (around `:42`), delete the `previewOpen: boolean` field.
2. In the `VaultLayout` defaults object (around `:54`), delete the `previewOpen: false` line.
3. Delete the module-level `_previewOpen = ref(false)` declaration (around `:81`).
4. In the serializer's `read` function (around `:144-153`), delete the `previewOpen` branch and any comment block that documents it. If the legacy-migration comment block is *only* about `previewOpen`, delete the whole block; otherwise, leave the surrounding code and just drop the `previewOpen`-specific lines.
5. In the persistence watcher (around `:185-187`), delete the `previewOpen` line from the write payload.
6. In the `useVaultLayout` return block (around `:204`), delete the `previewOpen` ref exposure.
7. Delete the `togglePreview()` action entirely (around `:269-276`).
8. In the return object (around `:285, :291`), delete the `previewOpen` and `togglePreview` keys.

The final `useVaultLayout.ts` should not export, declare, or reference `previewOpen` or `togglePreview` anywhere.

- [ ] **Step 9: Update `useVaultLayout.test.ts` — drop `previewOpen` cases, add the "unknown field" case**

Open `src/composables/vault/__tests__/useVaultLayout.test.ts`:

1. Run: `grep -n "previewOpen" src/composables/vault/__tests__/useVaultLayout.test.ts`
   If any lines are returned, delete every test or assertion that references `previewOpen`. (If no such cases exist, skip this step.)
2. Add the following new test inside the `describe('useVaultLayout', ...)` block:

```ts
it('drops unknown fields from persisted layout (forward-compat with old previewOpen)', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    rightRailTab: 'toc',
    rightRailWidth: 360,
    rightRailCollapsed: false,
    previewOpen: true, // legacy field from before Preview was removed
  }))
  __resetVaultLayoutState()
  const { layout } = setup()
  // No crash; the legacy field is simply ignored.
  expect(layout.rightRailTab.value).toBe('toc')
  expect(layout.rightRailWidth.value).toBe(360)
  // And it never re-emerges when the layout is rewritten.
  void layout.rightRailCollapsed.value // no-op touch
  expect(localStorage.getItem(STORAGE_KEY)!).not.toContain('previewOpen')
})
```

- [ ] **Step 10: Run the affected unit tests**

Run: `pnpm test -- src/composables/vault`
Expected: all green.

- [ ] **Step 11: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (If `VaultView.vue` still passes `togglePreview` to `useEditorTabs`, it will fail here — fix that here by also changing the call site in `VaultView.vue` to pass `toggleViewMode: () => viewModeApi.toggle()`. This is a small forward edit; do not skip it.)

- [ ] **Step 12: Commit**

```bash
git add \
  src/composables/vault/useVaultLayout.ts \
  src/composables/vault/__tests__/useVaultLayout.test.ts \
  src/composables/vault/useEditorTabs.ts \
  src/composables/vault/__tests__/useEditorTabs.test.ts \
  src/composables/vault/editor-tabs/useEditorShortcuts.ts \
  src/composables/vault/editor-tabs/useEditorShortcuts.test.ts \
  src/views/VaultView.vue
git commit -m "refactor(vault): remove previewOpen axis, bind Cmd/Ctrl+E

Drop the previewOpen state field, togglePreview action, and Cmd+\\
shortcut. Replace with toggleViewMode plumbing through useEditorTabs
and useEditorShortcuts, and add a new Cmd/Ctrl+E binding that toggles
between edit and read mode. Reading remains the only HTML render
surface; mode prop on RenderedMarkdown is removed in a follow-up.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Drop the `mode` prop from `RenderedMarkdown`

**Files:**
- Modify: `src/components/vault/RenderedMarkdown.vue`
- Modify: `src/components/vault/ReadingPane.vue`

- [ ] **Step 1: Read `RenderedMarkdown.vue` and confirm only the `mode` prop and class binding depend on it**

Run: `grep -n "mode" src/components/vault/RenderedMarkdown.vue`
Expected: lines for the prop declaration and the class binding only. If anything else references `mode`, stop and ask.

- [ ] **Step 2: Edit `RenderedMarkdown.vue` — drop the `mode` prop, hardcode `'article reading'`**

In `src/components/vault/RenderedMarkdown.vue`:

1. Delete the `mode: { type: String as PropType<'preview' | 'reading'>, default: 'reading' }` line from the `props` block.
2. Replace `:class="['article', mode]"` (or whatever the current class binding is — it may also be `:class="['article', props.mode]"` depending on the script setup style) with the static class:

```vue
<article class="article reading" ref="articleEl" @click="onArticleClick">
```

3. Delete any `import type { PropType } from 'vue'` line if it becomes unused after removing the prop.

- [ ] **Step 3: Edit `ReadingPane.vue` — drop `mode="reading"` from the `<RenderedMarkdown>` tag**

In `src/components/vault/ReadingPane.vue`, find the `<RenderedMarkdown>` element and remove the `mode="reading"` attribute. The element should be:

```vue
<RenderedMarkdown :raw="raw" :resolver="resolver" />
```

(Exact attribute names depend on the existing call site — keep whatever `:raw` and `:resolver` bindings already exist.)

- [ ] **Step 4: Run the markdown-render unit tests to confirm Reading behavior is unchanged**

Run: `pnpm test -- src/composables/vault/__tests__/useMarkdownRender.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/vault/RenderedMarkdown.vue src/components/vault/ReadingPane.vue
git commit -m "refactor(markdown): drop mode prop from RenderedMarkdown

Reading is the only HTML render surface after Preview is removed, so
the mode prop no longer carries a useful distinction. Hardcode the
'article reading' className on the article element.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Add `ICON_EDIT` to `icons.ts`

**Files:**
- Modify: `src/components/vault/icons.ts`

- [ ] **Step 1: Find `ICON_READ` and add `ICON_EDIT` immediately after it**

In `src/components/vault/icons.ts`, locate the existing `ICON_READ` block (currently near line 217). Immediately after its closing backtick + comment, append a new `ICON_EDIT` block. The shape mirrors `ICON_READ`:

```ts
// Edit — a pencil drawing a short stroke, the conventional "switch to
// edit" glyph. Stroke weights match the rest of the 14px icon set.
export const ICON_EDIT = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M11.5 2.5l2 2-8 8H3.5v-2z"/>
  <path d="M10.5 3.5l2 2"/>
</svg>`
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/vault/icons.ts
git commit -m "feat(icons): add ICON_EDIT for NavBar view-toggle

Pencil glyph matching the 14px stroke style of ICON_READ and other
NavBar icons. Used by the edit↔read toggle button.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Replace `ViewModeMenu` with NavBar toggle button

**Files:**
- Delete: `src/components/ViewModeMenu.vue`
- Delete: `src/components/__tests__/ViewModeMenu.test.ts`
- Modify: `src/components/NavBar.vue`
- Modify: `src/components/__tests__/NavBar.test.ts` (if it exists; create if it does not)

- [ ] **Step 1: Find or create the NavBar test file**

Run: `ls src/components/__tests__/NavBar.test.ts 2>/dev/null || echo "missing"`
If missing, create an empty test file as a placeholder so the subsequent test additions have a home:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import NavBar from '../NavBar.vue'
import { VaultViewModeKey, type VaultViewMode } from '../../composables/vault/viewMode'

function makeViewModeApi(initial: VaultViewMode = 'edit') {
  const mode = ref<VaultViewMode>(initial)
  return {
    mode,
    set: (m: VaultViewMode) => { mode.value = m },
    toggle: vi.fn(() => { mode.value = mode.value === 'edit' ? 'read' : 'edit' }),
  }
}

function mountNavBar(initial: VaultViewMode = 'edit') {
  const api = makeViewModeApi(initial)
  const wrapper = mount(NavBar, {
    global: {
      provide: { [VaultViewModeKey as symbol]: api },
    },
  })
  return { wrapper, api }
}

describe('NavBar — view-toggle button', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders a view-toggle button', () => {
    const { wrapper } = mountNavBar()
    expect(wrapper.find('[data-testid="view-toggle"]').exists()).toBe(true)
  })

  it('clicking the button calls viewModeApi.toggle()', async () => {
    const { wrapper, api } = mountNavBar()
    await wrapper.find('[data-testid="view-toggle"]').trigger('click')
    expect(api.toggle).toHaveBeenCalledOnce()
  })

  it('shows ICON_READ in edit mode (offering "switch to read")', () => {
    const { wrapper } = mountNavBar('edit')
    expect(wrapper.find('[data-testid="view-toggle"]').attributes('aria-label')).toBe('Switch to read')
  })

  it('shows ICON_EDIT in read mode (offering "switch to edit")', () => {
    const { wrapper } = mountNavBar('read')
    expect(wrapper.find('[data-testid="view-toggle"]').attributes('aria-label')).toBe('Switch to edit')
  })
})
```

> The exact import path of `VaultViewModeKey` is `src/composables/vault/viewMode.ts` (the file is one level deeper than `NavBar.vue`'s `__tests__/` location). Adjust the path if the existing `NavBar.test.ts` is structured differently — do not invent a new path.

- [ ] **Step 2: Run the NavBar test file to verify the new test fails**

Run: `pnpm test -- src/components/__tests__/NavBar.test.ts`
Expected: FAIL — the test for `data-testid="view-toggle"` cannot find the element because the current NavBar renders `<ViewModeMenu>` instead.

- [ ] **Step 3: Edit `NavBar.vue` — rewrite the header comment and replace `<ViewModeMenu>` with the toggle button**

Open `src/components/NavBar.vue`. Two changes:

1. **Replace the import + script-setup wiring.** Remove any `import ViewModeMenu from './ViewModeMenu.vue'` line. In the `setup` block, the `viewModeApi` and `isReadMode` should already be present (they were used to drive the old menu). Make sure both are still produced by the script-setup body. The icons import should now include `ICON_EDIT` and `ICON_READ`:

```ts
import { ICON_EDIT, ICON_READ } from './vault/icons'
```

2. **Replace the template.** Find the `<ViewModeMenu>` invocation and the block of imports/state above it. The new template body for the toggle slot is:

```vue
<button
  v-if="viewModeApi"
  class="view-toggle"
  :class="{ 'is-read': isReadMode }"
  :aria-label="isReadMode ? 'Switch to edit' : 'Switch to read'"
  :title="isReadMode ? 'Switch to edit (Cmd/Ctrl+E)' : 'Switch to read (Cmd/Ctrl+E)'"
  data-testid="view-toggle"
  @click="viewModeApi.toggle()"
>
  <span class="view-toggle__icon" v-html="isReadMode ? ICON_EDIT : ICON_READ" />
</button>
```

The `v-html` pattern matches the existing icon-injection style used elsewhere in this file (e.g. for the file-tree and other inline-icon buttons). If the file uses a different style (e.g. `<component :is>`), match that style.

3. **Rewrite the header comment block (`:29-66`)** to describe the new single button, including the `Cmd/Ctrl+E` shortcut and that the button reads `viewModeApi.toggle()`.

- [ ] **Step 4: Run the NavBar test file again to verify it passes**

Run: `pnpm test -- src/components/__tests__/NavBar.test.ts`
Expected: PASS — all 4 cases green.

- [ ] **Step 5: Delete `ViewModeMenu.vue` and its test file**

```bash
git rm src/components/ViewModeMenu.vue
git rm src/components/__tests__/ViewModeMenu.test.ts
```

- [ ] **Step 6: Typecheck and run the full unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS for both.

- [ ] **Step 7: Commit**

```bash
git add src/components/NavBar.vue src/components/__tests__/NavBar.test.ts
git commit -m "refactor(navbar): replace ViewModeMenu with single edit/read toggle

The three-option popover (Edit / Edit+Preview / Read) collapses to a
single toggle button now that Preview is gone. Click and Cmd/Ctrl+E
both call viewModeApi.toggle(). The new button carries
data-testid=view-toggle for E2E selector stability.

Co-Authored-By: Claude <noreply@anthropic.com>"
git status   # confirm ViewModeMenu files are staged for removal
git commit -m "chore: remove ViewModeMenu component and its tests

Co-Authored-By: Claude <noreply@anthropic.com>" -- src/components/ViewModeMenu.vue src/components/__tests__/ViewModeMenu.test.ts
```

(If `git status` after the first commit shows the deletions are already staged, drop the second commit.)

---

## Task 5: Strip scroll-sync wiring from `VaultView.vue` and `EditorPane.vue`

**Files:**
- Modify: `src/views/VaultView.vue`
- Modify: `src/components/vault/EditorPane.vue`

- [ ] **Step 1: Run the E2E scroll-sync suite to capture the current passing baseline**

Run: `pnpm test:e2e -- e2e/editor.spec.ts`
Expected: currently PASS (this confirms the scroll-sync is real, not dead code we can ignore).

- [ ] **Step 2: Edit `VaultView.vue` — drop scroll-sync composable usage and collapse the editor+preview split**

Open `src/views/VaultView.vue` and apply these edits:

1. In the import block (`:7`), delete the `useEditorPreviewScrollSync` import.
2. In the `useVaultLayout()` destructure (`:73-86`), remove `previewOpen, togglePreview` from the destructure list (the rest stays).
3. In the `useEditorTabs(...)` call (`:128`), drop the `togglePreview: ...` argument. The new shape passes `toggleViewMode: () => viewModeApi.toggle()` (this is the same forward edit done in Task 1 step 11; if it was already done, the call site is already correct).
4. Delete the `useEditorPreviewScrollSync(...)` instantiation (`:185-189`) entirely. This includes the const declaration and any side bindings.
5. In the template, find the `<div v-else-if="!isReadMode" class="content" :style="contentStyle">` block (`:316-368`). Replace its **entire** body with a single `<EditorPane>` mount:

```vue
<div v-else-if="!isReadMode" class="content">
  <div :data-path="activeTab.path" class="editor-pane">
    <EditorPane
      :key="activeTab.path"
      :path="activeTab.path"
      :initial-content="activeTab.content ?? ''"
    />
  </div>
</div>
```

(Adjust the prop names to match the existing `EditorPane` API. The three props above are illustrative — copy the exact prop bindings that existed in the old block before the split.)

6. Delete the `@scroll-change` binding on `<EditorPane>` (`:337`).
7. Delete the `<div v-if="tabs.length && previewOpen" class="splitter splitter-mid">` block (`:349-356`).
8. Delete the `<template v-if="previewOpen && activeTab">` mount of `<PreviewPane>` (`:358-367`), including the "Large document" notice at `:364`.

- [ ] **Step 3: Edit `EditorPane.vue` — drop scroll-sync events and the scroll-position API**

Open `src/components/vault/EditorPane.vue`:

1. In the `emits` block (`:43-50`), delete the three events `register-scroll`, `unregister-scroll`, and `scroll-change`. Keep the others.
2. Delete the `editor.onDidScrollChange` handler block (`:405-411`) that emits `scroll-change`.
3. Search for every `emit('register-scroll', ...)` and `emit('unregister-scroll', ...)` call site (around `:519, :528, :554, :571`) and delete those lines plus any surrounding `if`/`else` that exists only to support them.
4. Delete the `setScrollFraction` method (`:565-569`).
5. Delete the `getScrollEl` exposure (`:575`).
6. Delete the `IMMEDIATE_SCROLL` constant if it is now unused.

- [ ] **Step 4: Typecheck and run unit tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Run the E2E suite (excluding `e2e/editor.spec.ts` which we will delete in Task 6)**

Run: `pnpm test:e2e -- --grep-invert "scroll" | head -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/VaultView.vue src/components/vault/EditorPane.vue
git commit -m "refactor(editor): remove scroll-sync between Monaco and preview

After removing Preview, the only editor surface is Monaco itself;
there is nothing to scroll-sync with. Drop useEditorPreviewScrollSync,
the splitter-mid DOM, the Preview mount, the register-scroll /
unregister-scroll / scroll-change events, and the setScrollFraction /
getScrollEl exposures on EditorPane.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Delete Preview-only files and clean up dev routes

**Files:**
- Delete: `src/components/vault/PreviewPane.vue`
- Delete: `src/composables/vault/useEditorPreviewScrollSync.ts`
- Delete: `src/composables/vault/useEditorPreviewScrollSync.test.ts`
- Delete: `src/views/EditorTestView.vue`
- Delete: `e2e/editor.spec.ts`
- Modify: `src/router/index.ts`
- Modify: `src/views/MarkdownTestView.vue`
- Modify: `e2e/markdown-visual.spec.ts`

- [ ] **Step 1: Delete the Preview-only files**

```bash
git rm src/components/vault/PreviewPane.vue
git rm src/composables/vault/useEditorPreviewScrollSync.ts
git rm src/composables/vault/useEditorPreviewScrollSync.test.ts
git rm src/views/EditorTestView.vue
git rm e2e/editor.spec.ts
```

- [ ] **Step 2: Edit `src/router/index.ts` — drop the `/__editor-test` route**

Open `src/router/index.ts` and delete the route definition for `/__editor-test` (the dev-only preview test rig). The route's `component: () => import('../views/EditorTestView.vue')` is the easiest way to find it. Also remove the `EditorTestView` import if the file imports it explicitly.

- [ ] **Step 3: Edit `src/views/MarkdownTestView.vue` — keep only the reading branch**

In `src/views/MarkdownTestView.vue`:

1. Delete the `?mode=preview` branch (`:74-76`) and any branch that imports or renders `PreviewPane`.
2. Delete the preview-related CSS at `:86, :90-94` (or whatever lines carry `.preview-pane` selectors). Keep the reading-related CSS.
3. Optional: if the file's purpose is now entirely the reading surface, rename it to `ReadingTestView.vue` and update the router reference. Skip this if renaming would touch more than one router file.

- [ ] **Step 4: Edit `e2e/markdown-visual.spec.ts` — drop the preview-wrapper case**

Open `e2e/markdown-visual.spec.ts` and delete the first test (`:3-17`, the case titled `preview wrapper owns vertical scrolling`). The remaining tests cover both reading and editing surfaces and should be unaffected.

- [ ] **Step 5: Update `src/components/vault/__tests__/MonacoEditorPane.test.ts` — drop the preview-pane query**

In `src/components/vault/__tests__/MonacoEditorPane.test.ts` around line `:330`, delete the `previewPane.className = 'preview-pane'` setup and any test that depends on it. If the surrounding test still makes sense without that setup, leave it; otherwise delete the test.

- [ ] **Step 6: Typecheck and run unit tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Run the E2E suite to confirm the surviving tests still pass**

Run: `pnpm test:e2e`
Expected: PASS for the remaining E2E files (`e2e/markdown-visual.spec.ts` and any others not deleted in this task).

- [ ] **Step 8: Commit**

```bash
git add -A
git status   # confirm: only the deleted files + the targeted edits are staged
git commit -m "chore: remove preview-only files, dev routes, and tests

Delete PreviewPane, useEditorPreviewScrollSync, EditorTestView, and
the e2e/editor.spec.ts scroll-sync coverage. Drop the /__editor-test
route and the preview branch of MarkdownTestView. Update
MonacoEditorPane.test.ts to no longer reference a preview-pane DOM
node.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: CSS cleanup

**Files:**
- Modify: `src/style.css`

- [ ] **Step 1: Verify all `.preview-pane*` references are gone from Vue templates**

Run: `grep -r "preview-pane" src/`
Expected: empty (this is the spec's acceptance criterion #6). If anything remains, fix the Vue template first, then re-run.

- [ ] **Step 2: Edit `src/style.css` — drop the preview-related rules**

Open `src/style.css` and apply the following deletions. Each bullet is a contiguous range. Use `Edit` with the line range as `old_string`; if the surrounding context is large, narrow the match to just the rule block.

1. Delete lines `:2135-2151` (`.preview-pane` flex rules + `.preview-pane > .article`).
2. Delete lines `:2378-2388` (`.vault .preview-pane` and `.vault .preview-pane .article`).
3. In lines `:2326-2360`, change `:where(.preview-pane, .reading-pane)` to `.reading-pane` (the preview half is no longer needed).
4. Delete lines `:3528-3660` (the entire `.view-mode-menu*` block — the popover is gone).
5. Update the comment at `:1993-2000` from "editor/preview split" to describe the editor-only surface.

- [ ] **Step 3: Typecheck and run unit tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Run the E2E suite to confirm reading visuals are unchanged**

Run: `pnpm test:e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/style.css
git commit -m "style: remove preview-pane and view-mode-menu CSS

After Preview is removed, .preview-pane selectors and the
.view-mode-menu popover styles are dead. Drop them. The shared
.reading-pane scrollbar rule absorbs the preview half of the
:where() selector.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: E2E coverage + final verification

**Files:**
- Create: `e2e/view-mode.spec.ts`

- [ ] **Step 1: Read the existing E2E setup to mirror its conventions**

Run: `head -20 e2e/markdown-visual.spec.ts`
Note the imports, the `test.beforeEach` setup, and the page-object pattern. Mirror them in the new file.

- [ ] **Step 2: Create `e2e/view-mode.spec.ts`**

```ts
import { test, expect } from '@playwright/test'

test.describe('View mode toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/vault')
  })

  test('app opens in edit mode by default', async ({ page }) => {
    await expect(page.locator('[data-testid="view-toggle"]')).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('clicking the NavBar toggle button switches to read mode', async ({ page }) => {
    await page.locator('[data-testid="view-toggle"]').click()
    await expect(page.locator('[data-testid="view-toggle"]')).toHaveAttribute('aria-label', 'Switch to edit')
  })

  test('clicking again returns to edit mode', async ({ page }) => {
    const btn = page.locator('[data-testid="view-toggle"]')
    await btn.click()
    await btn.click()
    await expect(btn).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('Cmd+E toggles edit↔read from the editor', async ({ page }) => {
    const btn = page.locator('[data-testid="view-toggle"]')
    await expect(btn).toHaveAttribute('aria-label', 'Switch to read')
    await page.keyboard.press('Meta+e')
    await expect(btn).toHaveAttribute('aria-label', 'Switch to edit')
    await page.keyboard.press('Meta+e')
    await expect(btn).toHaveAttribute('aria-label', 'Switch to read')
  })

  test('viewMode persists across a hard refresh', async ({ page }) => {
    const btn = page.locator('[data-testid="view-toggle"]')
    await btn.click()
    await expect(btn).toHaveAttribute('aria-label', 'Switch to edit')
    await page.reload()
    await expect(btn).toHaveAttribute('aria-label', 'Switch to edit')
  })
})
```

- [ ] **Step 3: Run the new E2E file**

Run: `pnpm test:e2e -- e2e/view-mode.spec.ts`
Expected: PASS for all 5 cases.

- [ ] **Step 4: Run the spec's full verification gate (Spec §8)**

Run each of the following and confirm the expected output:

```sh
pnpm typecheck                                 # expect: clean
pnpm test                                      # expect: all green
pnpm test:e2e                                  # expect: all green

grep -r "previewOpen" src/                     # expect: empty
grep -r "togglePreview" src/                   # expect: empty
grep -r "\bPreviewPane\b" src/                 # expect: empty
grep -r "Cmd+\\\\" src/                        # expect: empty
grep -r "ViewModeMenu" src/                    # expect: empty
grep -r "useEditorPreviewScrollSync" src/      # expect: empty
grep -r "EditorTestView" src/                  # expect: empty
```

- [ ] **Step 5: Manual smoke test**

Run: `pnpm dev`
Visit `http://localhost:5173` (or whatever the dev URL is — check `package.json`):

1. The app opens in **edit** mode (Monaco visible).
2. The NavBar shows a single toggle button labelled "Switch to read" with the read icon.
3. Click the button → switches to **read** mode. The button now shows "Switch to edit" with the pencil icon.
4. Press `Cmd+E` from the editor → toggles back to edit.
5. Refresh the page → the last-selected mode is restored.
6. In read mode, click a heading in the TOC → scrolls to the heading. Click a `[[wiki-link]]` → navigates.
7. In edit mode, type in the editor → autosave fires (existing behavior).

- [ ] **Step 6: Commit**

```bash
git add e2e/view-mode.spec.ts
git commit -m "test(e2e): cover edit↔read toggle (mouse, keyboard, persistence)

Add e2e/view-mode.spec.ts with five cases: default mode, click toggle,
double click round-trip, Cmd+E from the editor, and viewMode survives
a hard refresh.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 Goals (delete Preview, replace menu, bind Cmd+E, preserve Reading) | Tasks 1, 4, 5, 6, 7 |
| §2 Non-Goals (Reading polish, Present mode) | Explicitly scoped out — no task |
| §3 Architecture (1D viewMode axis, single HTML surface, no scroll-sync) | Tasks 1, 2, 5 |
| §4.1 `viewMode` preserved | Task 1 (plumbing only) |
| §4.2 `previewOpen` removed | Task 1, Task 6 |
| §4.3 `Cmd/Ctrl+E` shortcut | Task 1 |
| §4.4 `toggleViewMode` plumbing | Task 1 |
| §5.1 Delete `ViewModeMenu.vue` | Task 4 |
| §5.2 NavBar toggle button | Tasks 3, 4 |
| §5.3 Comment blocks rewritten | Task 4 |
| §6.1 Whole-file deletions | Tasks 4, 6 |
| §6.2 Edit-existing files | Tasks 1, 2, 3, 4, 5, 6 |
| §6.3 CSS deletions | Task 7 |
| §6.4 Test edits | Tasks 1, 4, 6 |
| §7 Test strategy (unit + E2E + regression) | Tasks 1, 4, 8 |
| §8 Verification commands | Task 8 |

**Placeholder scan:** No `TBD` / `TODO` / "implement later" / "fill in details" remain. Every code step contains complete code; every test step contains a complete test.

**Type consistency:**

- `toggleViewMode?: () => void` — declared in Task 1 (useEditorShortcuts) and Task 1 (useEditorTabs); both task steps use the same name and signature.
- `viewModeApi.toggle()` — referenced in Task 4 (NavBar) and Task 1 (useEditorTabs plumbing); both use the same method name from the existing `VaultViewModeKey` provide in `App.vue`.
- `ICON_EDIT` / `ICON_READ` — declared in Task 3 and consumed in Task 4; both use the same exported const names.
- `data-testid="view-toggle"` — defined in Task 4 and asserted in Task 8; matches exactly.

**Gaps found during self-review:** None. All spec sections are covered; all placeholders are filled; all referenced symbols are declared in an earlier task.
