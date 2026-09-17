# Vault Tag Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tag clicks in the vault's `TagPanel` filter the in-vault `FileTree` to that tag's posts (and toggle off on re-click), instead of navigating away to the global `/tags/:tag` view.

**Architecture:** Lift filter state (`activeTagFilter: Ref<string | null>`) and a derived `filteredPosts: ComputedRef<PostSummary[]>` into `VaultView` — the existing controller. Pass the filtered list to `FileTree` (no internal change). Convert `TagPanel` from a `RouterLink`-driven navigation surface into a controlled button list that emits a `select` event.

**Tech Stack:** Vue 3 (`<script setup>`, `ref`, `computed`), Vue Router 4, TypeScript, plain CSS in `src/style.css`. **No test framework** is configured in this project; verification is `npm run build` (runs `vue-tsc -b && vite build`) for types plus the manual checklist at the end.

**Spec:** [docs/superpowers/specs/2026-06-02-vault-tag-filter-design.md](../specs/2026-06-02-vault-tag-filter-design.md)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue) | **Modify** | Hold `activeTag` prop, emit `select` event, render `<button>` instead of `<RouterLink>`. |
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | **Modify** | Own `activeTagFilter` ref, `filteredPosts` computed, `onTagSelect` handler; rewire template to pass them down. |
| [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) | **No change** | Already accepts `posts: PostSummary[]`; receives the filtered array. |
| [src/style.css](../../../src/style.css) | **Modify** | Add `.vault .tag-panel .tag-entry.active` rules in the existing tag-panel block (lines ~506–557). |

Two files changed, one CSS block appended. State lives in `VaultView`; children are dumb.

---

## Task 1: Convert TagPanel to a controlled, button-based component

**Files:**
- Modify: `src/components/vault/TagPanel.vue` (full file: 36 lines, rewrite)

### Step 1: Replace the entire TagPanel.vue file

**Why:** Spec §4.1 — replace `RouterLink` with `<button>`, add `activeTag` prop, emit `select`, drop the unused `RouterLink` import. The full file is small enough to rewrite cleanly.

Replace the **entire** contents of `src/components/vault/TagPanel.vue` with:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { PostSummary } from '../../lib/api'

const props = defineProps<{
  posts: PostSummary[]
  activeTag: string | null
}>()

defineEmits<{
  select: [tag: string]
}>()

const tagMap = computed(() => {
  const map = new Map<string, number>()
  for (const p of props.posts) {
    for (const t of p.tags) {
      map.set(t, (map.get(t) ?? 0) + 1)
    }
  }
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
})
</script>

<template>
  <aside class="tag-panel" aria-label="Tags panel">
    <header>
      <span class="title">Tags</span>
      <span class="count">{{ tagMap.length }}</span>
    </header>
    <ul v-if="tagMap.length">
      <li v-for="[tag, count] in tagMap" :key="tag">
        <button
          class="tag-entry"
          :class="{ active: tag === activeTag }"
          :aria-pressed="tag === activeTag"
          @click="$emit('select', tag)"
        >
          <span class="tag-name">#{{ tag }}</span>
          <span class="tag-count">{{ count }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="empty">No tags yet.</p>
  </aside>
</template>
```

**Changes vs. current file:**
- Removed `import { RouterLink } from 'vue-router'`.
- `defineProps` now includes `activeTag: string | null`.
- Replaced `defineEmits` import + `<script setup>` implicit emit typing with explicit `defineEmits<{ select: [tag: string] }>()`.
- `<RouterLink class="tag-entry" :to="...">` → `<button class="tag-entry" :class="{ active: ... }" :aria-pressed="..." @click="$emit('select', tag)">`.
- Added `aria-pressed` for accessibility (mirrors the pattern already used in `ActivityBar.vue:16`).

### Step 2: Build to verify types

Run:
```bash
cd d:/sdk/nuvyn && npm run build
```

**Expected:** The TypeScript check **fails** with errors like:

```
src/views/VaultView.vue:374:5 - error TS2339: Property 'activeTag' does not exist on type ...
src/views/VaultView.vue:374:5 - error TS2339: Property 'select' does not exist on type ...
```

This is **intentional** — the build will pass again once Task 2 wires the new prop/emit on the consumer side. Do not skip this step; confirming the failure here proves the change is actually a change.

### Step 3: Manual smoke check (in dev server)

Start the dev server in a separate terminal:
```bash
cd d:/sdk/nuvyn && npm run dev
```

Open the vault, switch to the Tags panel.

**Expected visual behavior:**
- Each tag renders as a button (same look as before; existing `.tag-entry` CSS still applies).
- Clicking a tag no longer navigates anywhere (because we removed the `RouterLink` and the consumer still passes the old props, so the click handler is effectively a no-op for now).
- Console: a Vue warning may appear about "Component emitted event 'select' but it is not declared" — this is because `VaultView` is still using the old template; expected and fine for now.

If clicking a tag still navigates to `/tags/:tag` and changes the URL, the `RouterLink` is still in the file — re-check Step 1.

### Step 4: Commit

```bash
git add src/components/vault/TagPanel.vue
git commit -m "refactor(vault): make TagPanel a controlled, button-based component

Drops the in-TagPanel RouterLink and replaces it with a plain <button> that
emits 'select'. Adds an activeTag prop and aria-pressed for accessibility.
The consumer (VaultView) is updated in the next commit to wire these
new props/emit; the build currently fails on purpose to prove this is
a real behavioral change."
```

---

## Task 2: Add filter state, handler, template wiring, and active CSS in VaultView

**Files:**
- Modify: `src/views/VaultView.vue` (script + template, 2 surgical edits)
- Modify: `src/style.css` (append 1 rule in the existing tag-panel block)

### Step 1: Add filter state, computed, and handler to VaultView script

Open `src/views/VaultView.vue`. After the existing `const activeSize = computed(...)` block ending at line 152, **add** the following block. Locate the exact anchor: the line right after `})` closing `activeSize`, before the blank line and `async function refresh()`.

Insert this between line 152 and the existing `async function refresh()`:

```ts
/* ---------- Tag filter (view-state, in-memory) ---------- */
const activeTagFilter = ref<string | null>(null)
const filteredPosts = computed(() => {
  const t = activeTagFilter.value
  return t ? posts.value.filter((p) => p.tags.includes(t)) : posts.value
})
function onTagSelect(tag: string) {
  if (activeTagFilter.value === tag) {
    activeTagFilter.value = null          // toggle off
  } else {
    activeTagFilter.value = tag
    activePanel.value = 'files'           // ensure file tree is visible
  }
}
```

**Why here:** Same module-level `ref`/`computed` pattern already used by `posts`, `tabs`, `activeSlug`. The handler sits alongside `openPost`/`onNew`/etc. for symmetry.

### Step 2: Rewire template — pass filtered list to FileTree, new props/emit to TagPanel

In `src/views/VaultView.vue`, locate the existing template block (around lines 365–374). Change **two lines**:

**Change A** — the `<FileTree>` element (around line 365–373):

```vue
    <FileTree
      v-if="activePanel === 'files'"
      :posts="filteredPosts"
      :current-slug="activeSlug"
      @select="openPost"
      @new="onNewFromTree"
      @rename="onRename"
      @delete="onDelete"
    />
```

Only the `:posts` binding changed (from `"posts"` to `"filteredPosts"`). The rest is unchanged.

**Change B** — the `<TagPanel>` element (line 374):

```vue
    <TagPanel
      v-else-if="activePanel === 'tags'"
      :posts="posts"
      :active-tag="activeTagFilter"
      @select="onTagSelect"
    />
```

New `:active-tag` and `@select` bindings added; `:posts` stays as the unfiltered list so tag counts remain correct.

### Step 3: Add the `.tag-entry.active` CSS

In `src/style.css`, locate the existing tag-panel block. The current rule for hover is on line 543:

```css
.vault .tag-panel .tag-entry:hover { background: var(--vs-hover-bg); }
```

**Insert directly after that line** (so the new rule sits with its siblings):

```css
.vault .tag-panel .tag-entry.active {
  background: var(--vs-active-bg);
  color: var(--vs-text-1);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--vs-accent);
}
.vault .tag-panel .tag-entry.active:hover { background: var(--vs-active-bg); }
```

**Why this look:** Matches the existing FileTree active-row pattern: `var(--vs-active-bg)` is the row background used for the selected file (see `.vault .file-tree li.active` at line 470), and the inset accent stripe on the left mirrors how the active tree-row gets a colored border. The `.active:hover` override prevents the hover style from re-graying the active row.

### Step 4: Build to verify everything typechecks

Run:
```bash
cd d:/sdk/nuvyn && npm run build
```

**Expected:** Build **succeeds**. No type errors. The intentional failure from Task 1 should be gone now that `VaultView` provides the new `activeTag` prop and listens for the `select` emit.

If the build fails, the most likely cause is a typo in the prop/emit name — re-check that the names (`activeTag`, `select`) match exactly between `TagPanel.vue` and `VaultView.vue`.

### Step 5: Manual smoke check in dev server

With the dev server still running (or restart it):

1. **Basic toggle (spec §2, item 1 + 2):**
   - Switch to Tags panel, click `#foo` (use any tag that exists in your posts).
   - Files panel opens automatically. FileTree shows only posts containing `foo`. `#foo` is visually highlighted in the TagPanel (background change + left accent stripe).
   - Click `#foo` again. FileTree shows all posts. No highlight.

2. **Replacement (spec §2, item 3):**
   - Click `#foo` (filter active), then click `#bar`.
   - Tree now shows only `bar` posts. Only `#bar` is highlighted.

3. **Persistence across post open (spec §2, item 4):**
   - With filter active, open a post from the tree.
   - Post opens in editor. Close the tab.
   - FileTree is still filtered. Tag is still highlighted.

If any of these fail, the most likely culprit is that the template edit didn't take — re-check Step 2.

### Step 6: Commit

```bash
git add src/views/VaultView.vue src/style.css
git commit -m "feat(vault): filter FileTree by tag click in TagPanel

Adds a single-tag, in-memory filter driven by clicks in the Tags panel.
The active tag is highlighted in TagPanel and the FileTree is replaced
with the filtered list. Re-clicking the active tag clears the filter.

The filter is in-memory only (no URL persistence, no localStorage); a
page reload clears it. This is a view-state, not a shareable link."
```

---

## Task 3: Run the spec's full manual verification checklist

**Files:** No code changes expected. If any check fails, fix in a follow-up commit.

This task is verification only. The 7 scenarios below come directly from spec §2 + §8. Run them in order. The dev server from Task 2 should still be running; if not, `cd d:/sdk/nuvyn && npm run dev`.

For each scenario, tick the box only after the actual UI behavior matches the expected.

### Checklist

- [ ] **1. Basic toggle.** Tags panel → click `#foo` → Files panel opens, tree shows only `foo` posts, `#foo` highlighted. Click `#foo` again → tree shows all posts, no highlight.

- [ ] **2. Replace.** With `#foo` active, click `#bar` → tree shows only `bar` posts, only `#bar` highlighted.

- [ ] **3. Persistence across post open.** Filter active → open a post from the tree → close the tab → tree still filtered.

- [ ] **4. Persistence across panel switch.** Filter active → switch to Tags panel → `#foo` still highlighted → switch back to Files → still filtered.

- [ ] **5. Write operations under filter.** Filter active, then:
   - Create a new post (use the `+ New` button in the file tree header) without `foo` tag → new post not in filtered tree.
   - Delete a post that has `foo` → tree updates, post gone.
   - Open a post with `foo`, edit its frontmatter to remove `foo`, save (Ctrl+S) → that post drops out of the filtered tree.

- [ ] **6. Reset on reload.** Filter active → refresh the page (F5) → filter cleared, all posts shown.

- [ ] **7. Regression.** Filter inactive → open Tags panel → tag list and counts are correct. Filter inactive → Cmd+P palette → finds all posts (including those that would be hidden by a filter, because we don't have one active). Filter active → FileTree's `+ New`, rename, delete actions still work for the visible posts.

### If anything failed

For each failure, file a follow-up. The most likely failure modes and their fixes:

- **Click on tag does nothing** → check that `@click="$emit('select', tag)"` is intact in `TagPanel.vue` and that `VaultView.vue` template has `@select="onTagSelect"`.
- **Click on tag still navigates to `/tags/:foo`** → some leftover `<RouterLink>`; re-read Task 1 Step 1.
- **Filter highlights but FileTree doesn't shrink** → `filteredPosts` computed not connected; check `:posts="filteredPosts"` on the `<FileTree>` element.
- **FileTree shrinks but tag panel doesn't highlight** → `:active-tag` binding wrong; check `VaultView.vue` template and that `activeTagFilter` is a `ref<string | null>` (not a plain string).
- **Active row look is off** → check the CSS in `src/style.css`; the two selectors `.tag-entry.active` and `.tag-entry.active:hover` must both be present.

Any fix is a separate small commit; do not amend Task 2.

### Step: Mark Task 3 done

Once all 7 boxes are ticked, this task is done. No commit needed unless fixes were required.

---

## Self-Review

**Spec coverage** (spec sections → plan tasks):

- Spec §1 (Problem & Goal) → Task 1 + Task 2 (replaces `RouterLink` with internal filter, achieves the goal of staying in-vault).
- Spec §2 (Behavior table, items 1–7) → Task 2 implements the runtime; Task 3 verifies all 7 manually.
- Spec §3 (Architecture: state in `VaultView`) → Task 2 Step 1.
- Spec §4.1 (`TagPanel.vue` changes) → Task 1.
- Spec §4.2 (`VaultView.vue` changes) → Task 2 Steps 1 + 2.
- Spec §4.3 (no `FileTree` change) → called out explicitly in File Structure table; no task touches it.
- Spec §5 (Data flow) → Task 2 Step 5 (visual) + Task 3 (verification).
- Spec §6 (Edge cases) → Task 3 (manually exercised via the write-operations step).
- Spec §7 (Out of scope) → no tasks for URL persistence / multi-tag / palette filtering — explicit by absence.
- Spec §8 (Verification) → Task 2 Step 4 (build) + Task 3 (manual checklist).
- Spec §9 (Files touched) → matches File Structure table above.

**Placeholder scan:** No "TBD", "TODO", "add appropriate", "fill in details", or "similar to Task N". All code shown is the actual code to be written.

**Type/name consistency:**
- `activeTagFilter` defined once in `VaultView.vue` (Task 2), referenced in template, never renamed.
- `filteredPosts` defined once in `VaultView.vue`, passed to `<FileTree>`.
- `activeTag` defined as a prop in `TagPanel.vue` (Task 1), passed as `:active-tag` from `VaultView.vue` (Task 2). Kebab ↔ camel conversion is Vue's standard — no mismatch.
- `select` event defined in `TagPanel.vue` (`defineEmits<{ select: [tag: string] }>()`), listened to as `@select="onTagSelect"` in `VaultView.vue`. Same name throughout.
- `onTagSelect(tag: string)` is the only handler that updates `activeTagFilter`. No other writer.
- `posts` (unfiltered) is what `TagPanel` receives; `filteredPosts` is what `FileTree` receives. Spec §3 invariant preserved.

**Granularity check:** Each step is a single action. Steps 2 in Task 1 (build fails on purpose) and Step 4 in Task 2 (build passes) are the type-check loop that stands in for "test before commit" given the project has no test framework.
