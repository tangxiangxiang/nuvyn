# Vault Tag Filter — Design

**Date:** 2026-06-02
**Status:** Approved
**Scope:** Add tag-driven file-tree filtering to the vault editor. Clicking a tag in the in-vault `TagPanel` filters the `FileTree` to that tag's posts; clicking the same tag again clears the filter.

## 1. Problem & Goal

The vault's side-panel `TagPanel` currently lists all tags but each entry is a `<RouterLink to="/tags/{tag}">` that navigates away from the vault to a global `TagDetailView`. The vault is a focused editing surface — leaving it to browse tag groups breaks flow.

**Goal:** Let users browse posts by tag *inside the vault*, without leaving the editor. The editor area itself does not change; the filtering is a view-state applied to the file tree.

## 2. Behavior (UX contract)

| # | Action | Result |
|---|---|---|
| 1 | In Tags panel, click `#foo` | Auto-switches to Files panel; `FileTree` shows only posts with `foo`; `#foo` highlighted in `TagPanel`. |
| 2 | With filter active, click `#foo` again | Filter cleared; `FileTree` shows all posts; no highlight. |
| 3 | With filter `#foo` active, click `#bar` | Filter switches from `foo` to `bar` (replacement, not stacking). |
| 4 | With filter active, open a post from `FileTree` | Post opens in editor; filter remains active afterwards. |
| 5 | With filter active, switch to Tags panel and back | Filter is still active; highlighting still shows. |
| 6 | Page reload / leave & return to `/vault` | Filter resets to `null` (in-memory only, by design). |
| 7 | With filter active, use Cmd+P palette | Palette searches *all* posts (not just filtered); filter does not constrain global search. |

## 3. Architecture

State lives in `VaultView` — the existing controller for the vault surface. Two additions:

- `activeTagFilter: Ref<string | null>` — the single source of truth for the active tag (or `null` when unfiltered).
- `filteredPosts: ComputedRef<PostSummary[]>` — derived from `posts` and `activeTagFilter`.

```ts
// src/views/VaultView.vue (additions)
const activeTagFilter = ref<string | null>(null)

const filteredPosts = computed(() => {
  const t = activeTagFilter.value
  return t ? posts.value.filter(p => p.tags.includes(t)) : posts.value
})

function onTagSelect(tag: string) {
  if (activeTagFilter.value === tag) {
    activeTagFilter.value = null                // toggle off
  } else {
    activeTagFilter.value = tag
    activePanel.value = 'files'                 // ensure file tree is visible
  }
}
```

`posts` (the **unfiltered** list) continues to drive everything that needs the full set: tag count aggregation in `TagPanel`, the `CommandPalette` results, and post creation/refresh flows.

## 4. Component Changes

### 4.1 [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue)

- Drop `RouterLink` import; the entries become plain `<button>` elements.
- New prop: `activeTag: string | null`.
- Replace `<RouterLink class="tag-entry" :to="...">` with:
  ```html
  <button class="tag-entry" :class="{ active: tag === activeTag }" @click="emit('select', tag)">
    <span class="tag-name">#{{ tag }}</span>
    <span class="tag-count">{{ count }}</span>
  </button>
  ```
- `defineEmits<{ select: [tag: string] }>()`.
- Add CSS for `.tag-entry.active` (use existing `--vs-active-bg` and an accent left-border to match FileTree's selected-row pattern).
- Strip the now-unused `RouterLink` import.

### 4.2 [src/views/VaultView.vue](../../../src/views/VaultView.vue)

- Add `activeTagFilter`, `filteredPosts`, `onTagSelect` (per §3).
- In template:
  - `<FileTree :posts="filteredPosts" ...>` (was `posts`).
  - `<TagPanel :posts="posts" :active-tag="activeTagFilter" @select="onTagSelect" />`.
- No new imports beyond what's already present.

### 4.3 [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue)

**No changes.** The component already accepts `posts: PostSummary[]` and renders whatever it receives. Filtering is applied by the parent before passing data in.

## 5. Data Flow

```
User clicks "#foo" in TagPanel
  → TagPanel emits 'select' with 'foo'
  → VaultView.onTagSelect('foo')
      • if same as activeTagFilter → set to null
      • else → set to 'foo' and activePanel = 'files'
  → Vue reactivity
      • filteredPosts recomputes
      • FileTree re-renders with smaller posts array
      • TagPanel re-renders with new activeTag prop → .active class applied
```

## 6. Edge Cases

| Scenario | Behavior |
|---|---|
| Filter active; create a new post without that tag | Post created and opened normally; absent from filtered tree. |
| Filter active; delete a post with that tag | `refresh()` runs; `filteredPosts` shrinks. Empty tree shows "No posts." |
| Filter active; rename a post | Slug changes, tags don't → post stays in filtered tree. |
| Filter active; edit a post's frontmatter and remove the tag | After `savePost` + `refresh()`, post drops out of `filteredPosts`. |
| Active tag disappears from `posts` entirely | `filteredPosts` becomes empty; filter not auto-cleared (user intent preserved). |
| Filter active; click Files activity-bar button to close panel | `activePanel = null`; filter remains active. Click Files again to restore. |
| Filter active; Cmd+P palette | Palette uses unfiltered `posts`; filter does not constrain global search. |

No new failure modes: this feature has no new I/O, no new persistence, no new error paths.

## 7. Out of Scope (YAGNI)

- URL persistence (`/vault?tag=foo` query param) — can be layered on later if shareable links become a need.
- Multi-tag AND/OR filters — single-tag replacement is sufficient for v1; can be extended.
- Tag-filtering of `CommandPalette` results — palette is a "go-to-anything" tool, not a browse tool.
- Inline tag chips inside the editor preview — separate feature.
- Persisting filter across page reload — not requested; state is in-memory by design.

## 8. Verification

Project has no unit test framework. Verification is `npm run build` (runs `vue-tsc -b && vite build`) plus a manual checklist.

**Build**
```bash
npm run build
```
Confirms `filteredPosts`, `activeTagFilter`, and the new `activeTag` prop typecheck cleanly.

**Manual checklist**

1. **Basic toggle.** In Tags panel click `#foo` → switches to Files panel, tree filtered to `foo`, `#foo` highlighted. Click `#foo` again → cleared, all posts shown, no highlight.
2. **Replace.** With `#foo` active, click `#bar` → filter swaps to `bar`; only `#bar` highlighted.
3. **Persistence across post open.** With filter active, open a post from the tree → post opens, filter remains active after closing the tab.
4. **Persistence across panel switch.** With filter active, switch to Tags panel and back → filter still active and highlighted.
5. **Write operations under filter.** With filter active: create a post without the tag (absent from tree), delete a post with the tag (gone from tree), edit a post to remove the tag (drops out of tree after save).
6. **Reset on reload.** With filter active, press F5 → filter cleared, all posts shown.
7. **Regression.** Tags panel still computes tag list and counts from the full set; Cmd+P still finds every post; FileTree's new/rename/delete actions still work under a filter.

## 9. Files Touched

| File | Change |
|---|---|
| [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue) | Replace `RouterLink` with `<button>`; add `activeTag` prop; emit `select`; add `.active` CSS. |
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | Add `activeTagFilter` ref, `filteredPosts` computed, `onTagSelect` handler; rewire template. |
| [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) | No change. |
