# AI Live Note Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI panel send the *live editor buffer* (not the last server-saved snapshot) as `currentNoteContent` on every chat send, so freshly typed text shows up in the model's context immediately.

**Architecture:** A module-level `_liveTabs: ShallowRef<Tab[]>` is owned by `src/composables/vault/useEditorTabs.ts`. The composable publishes its per-mount `tabs` ref to `_liveTabs` and mirrors future mutations via `watch(…, { flush: 'post' })`. `src/composables/vault/useCurrentNote.ts` becomes a consumer: it calls `getLiveTabs()` and prefers `tab.raw` over its existing `getPost` fallback when a matching tab is open. No server changes. No new files.

**Tech Stack:** Vue 3 (`shallowRef`, `watch`), TypeScript, Vitest (jsdom for `src/**/*.test.ts`).

**Spec:** [docs/superpowers/specs/2026-06-07-ai-live-note-context.md](../specs/2026-06-07-ai-live-note-context.md)

---

## File map

| File | Role | Change |
|---|---|---|
| `src/composables/vault/useEditorTabs.ts` | Tab state + save machine | Add module-level `_liveTabs`, `getLiveTabs()`, `__setLiveTabsForTesting()`, `__resetLiveTabsForTesting()`. Publish `tabs` to `_liveTabs` at end of `useEditorTabs()`. |
| `src/composables/vault/useCurrentNote.ts` | Active-note path+content resolution | Replace the inline `watch` with `watch([routePath, liveTabs], resolveContent, { deep: true })`. New `resolveContent()` helper: live tab → `getPost` fallback. |
| `src/composables/vault/__tests__/useEditorTabs.test.ts` | Tests for tab state | Add 1 test: `useEditorTabs` mount publishes `_liveTabs` and mirrors mutations. |
| `src/composables/vault/__tests__/useCurrentNote.test.ts` | Tests for current-note resolution | Add 3 tests: live tab hit, fallback, live mutation propagation. |
| `src/components/vault/tabs.ts` | (no change) | `Tab` type already defines `raw: string`, `loading: boolean`, etc. — reused. |

No DB migration, no new dependencies.

---

## Task 1: Add the live-tabs publish API to `useEditorTabs.ts`

**Files:**
- Modify: `src/composables/vault/useEditorTabs.ts:1-35` (imports + module-level state + new exports)
- Modify: `src/composables/vault/useEditorTabs.ts:248-266` (return statement area — add the publish call)
- Modify: `src/composables/vault/__tests__/useEditorTabs.test.ts` (add 1 new test)

- [ ] **Step 1.1: Write the failing unit test for the new exports**

Add the following to `src/composables/vault/__tests__/useEditorTabs.test.ts` (right after the existing `beforeEach`/`afterEach` block, before the existing `describe` block — search for an empty line that fits):

```ts
import { getLiveTabs, __setLiveTabsForTesting, __resetLiveTabsForTesting } from '../useEditorTabs'
import { shallowRef } from 'vue'
import type { Tab } from '../../../components/vault/tabs'

describe('live tabs publish', () => {
  beforeEach(() => {
    __resetLiveTabsForTesting()
  })

  it('returns null from getLiveTabs() before useEditorTabs is mounted', () => {
    expect(getLiveTabs()).toBeNull()
  })

  it('returns a ShallowRef<Tab[]> after useEditorTabs is mounted and mirrors tabs.value mutations', async () => {
    // Stand up a no-op component to host useEditorTabs' router + side-effects.
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/vault/:path(.*)*', name: 'vault', component: { template: '<div/>' } }],
    })
    router.push('/tags') // /tags has no pathMatch, so openPost is not called
    await router.isReady()

    // Stub fetch — useEditorTabs.refresh() calls getTree() and listPosts()
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ tree: [], posts: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch

    let capturedTabs: any = null
    const Comp = defineComponent({
      setup() {
        const t = useEditorTabs({ selectPanel: () => {} })
        capturedTabs = t.tabs
        return () => h('div')
      },
    })
    const wrap = mount(Comp, { global: { plugins: [router] } })
    await flushPromises()

    // After mount, getLiveTabs() must return a ref that points at the
    // current tabs array.
    const live = getLiveTabs()
    expect(live).not.toBeNull()
    expect(live!.value).toBe(capturedTabs.value)

    // Mutating tabs.value (simulating openPost / onEditorChange) must
    // propagate to _liveTabs via the flush:post mirror watch.
    const newTab: Tab = {
      path: 'x.md', title: 'x', raw: 'live', originalRaw: '',
      saveStatus: 'idle', error: null, loadError: null, loading: false,
    }
    capturedTabs.value = [newTab]
    await nextTick()
    await nextTick() // flush:post runs after the next microtask
    expect(live!.value).toEqual([newTab])

    wrap.unmount()
  })

  it('__setLiveTabsForTesting overrides the published ref; __resetLiveTabsForTesting clears it', () => {
    const fake = shallowRef<Tab[]>([])
    __setLiveTabsForTesting(fake)
    expect(getLiveTabs()).toBe(fake)
    __resetLiveTabsForTesting()
    expect(getLiveTabs()).toBeNull()
  })
})
```

If `flushPromises` and `nextTick` are not already imported in this file, add them to the existing import line at the top of `useEditorTabs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef, type Ref } from 'vue'   // add shallowRef
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'                           // add flushPromises
```

- [ ] **Step 1.2: Run the new test, expect it to fail**

Run: `pnpm test src/composables/vault/__tests__/useEditorTabs.test.ts`
Expected: the 3 new tests in `describe('live tabs publish')` fail. The error will be `getLiveTabs is not a function` (or similar) because the new exports don't exist yet. The pre-existing tests in this file should still pass.

- [ ] **Step 1.3: Add the module-level state + new exports**

In `src/composables/vault/useEditorTabs.ts`:

1. Update the Vue import line (line 18) to add `shallowRef` and `type ShallowRef`:

```ts
import { computed, onMounted, ref, shallowRef, watch, type ShallowRef } from 'vue'
```

2. Add the `Tab` type import (right after the existing `import type { Tab } from '../../components/vault/tabs'` line, which is already at line 31 — keep it). No new import needed.

3. At the top of the file (right after the imports, before `export function useEditorTabs`), add:

```ts
// ---- live tabs publish ----
//
// useEditorTabs is a per-mount composable (it takes `selectPanel` as a
// constructor arg, so the AI panel can't call it from useCurrentNote).
// We side-step that by exposing a module-level ref that
// useEditorTabs publishes to once on mount. useCurrentNote reads it via
// getLiveTabs() and prefers tab.raw over its getPost fallback. This
// keeps the editor buffer live without coupling the two composables'
// function signatures.
//
// The mirror watch is `flush: 'post'` so consumers see the same value
// useEditorTabs saw, not a pre-flush snapshot — that way the AI panel's
// content never lags the editor by a tick.
//
// Test-only escape hatches at the bottom of the block match the
// __resetForTesting pattern used elsewhere.

let _liveTabs: ShallowRef<Tab[]> | null = null
let _mirrorStop: (() => void) | null = null

function _teardownMirror() {
  _mirrorStop?.()
  _mirrorStop = null
}

export function getLiveTabs(): ShallowRef<Tab[]> | null {
  return _liveTabs
}

export function __setLiveTabsForTesting(ref: ShallowRef<Tab[]> | null): void {
  _teardownMirror()
  _liveTabs = ref
}

export function __resetLiveTabsForTesting(): void {
  _teardownMirror()
  _liveTabs = null
}
```

- [ ] **Step 1.4: Add the publish call at the end of `useEditorTabs()`**

In `src/composables/vault/useEditorTabs.ts`, find the `return { ... }` block at the bottom of `useEditorTabs()` (around line 249). Right before that `return`, add:

```ts
    // Publish our tabs ref to the module-level mirror so other
    // composables (e.g. useCurrentNote) can read it. The watch keeps
    // _liveTabs.value in lockstep with our local `tabs` ref.
    _teardownMirror()
    if (!_liveTabs) _liveTabs = shallowRef<Tab[]>(tabs.value)
    _mirrorStop = watch(
      tabs,
      (v) => { if (_liveTabs) _liveTabs.value = v },
      { flush: 'post' },
    )

    return {
```

(The original `return {` is the first line of the existing return object — keep it. The new code goes *above* the `return`.)

- [ ] **Step 1.5: Run the new tests, expect them to pass**

Run: `pnpm test src/composables/vault/__tests__/useEditorTabs.test.ts`
Expected: all tests pass, including the 3 new ones in `describe('live tabs publish')`.

- [ ] **Step 1.6: Commit**

```bash
git add src/composables/vault/useEditorTabs.ts src/composables/vault/__tests__/useEditorTabs.test.ts
git commit -m "feat(vault): publish live tabs ref from useEditorTabs

Adds a module-level _liveTabs ShallowRef that useEditorTabs publishes to
on first mount and mirrors future mutations from. The export surface
(getLiveTabs, __setLiveTabsForTesting, __resetLiveTabsForTesting) lets
other composables read the editor's live buffer without coupling to
useEditorTabs' per-mount function signature.

Required for the AI panel to send the live editor content (rather than
the server-saved snapshot) as currentNoteContent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Write the failing live-tab tests for `useCurrentNote`

**Files:**
- Modify: `src/composables/vault/__tests__/useCurrentNote.test.ts`

- [ ] **Step 2.1: Add the 3 failing tests**

Append the following `describe` block at the end of `src/composables/vault/__tests__/useCurrentNote.test.ts` (after the existing `describe('useCurrentNote', …)` block):

```ts
import {
  getLiveTabs,
  __setLiveTabsForTesting,
  __resetLiveTabsForTesting,
} from '../useEditorTabs'
import { shallowRef } from 'vue'
import type { Tab } from '../../../components/vault/tabs'

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    path: 'foo.md',
    title: 'foo',
    raw: '',
    originalRaw: '',
    saveStatus: 'idle',
    error: null,
    loadError: null,
    loading: false,
    ...overrides,
  }
}

describe('useCurrentNote — live tab integration', () => {
  beforeEach(() => {
    __setLiveTabsForTesting(shallowRef<Tab[]>([]))
  })

  afterEach(() => {
    __resetLiveTabsForTesting()
  })

  it('uses tab.raw when a live tab exists for the route path', async () => {
    const live = getLiveTabs()!
    live.value = [makeTab({ path: 'foo.md', raw: 'live content' })]
    const { note } = await mountAtRoute('/vault/foo.md')
    expect(note.path.value).toBe('foo.md')
    expect(note.content.value).toBe('live content')
  })

  it('falls back to getPost when no live tab exists for the route path', async () => {
    responses.push({ status: 200, body: { content: 'from-server', frontmatter: {} } })
    const { note } = await mountAtRoute('/vault/missing.md')
    expect(note.path.value).toBe('missing.md')
    expect(note.content.value).toBe('from-server')
  })

  it('updates content when the live tab.raw mutates (typing)', async () => {
    const live = getLiveTabs()!
    live.value = [makeTab({ path: 'foo.md', raw: 'a' })]
    const { note } = await mountAtRoute('/vault/foo.md')
    expect(note.content.value).toBe('a')

    // Simulate a keystroke: useEditorTabs would call onEditorChange →
    // tabs.value = [{ ...prev, raw: 'ab' }] → mirror watch propagates.
    live.value = [makeTab({ path: 'foo.md', raw: 'ab' })]
    await flushPromises()
    expect(note.content.value).toBe('ab')
  })
})
```

- [ ] **Step 2.2: Run the new tests, expect them to fail**

Run: `pnpm test src/composables/vault/__tests__/useCurrentNote.test.ts`
Expected:
- The 4 pre-existing tests still pass.
- The 3 new tests in `describe('useCurrentNote — live tab integration')` fail.
- Failure reason: `useCurrentNote` still calls `getPost` unconditionally, so:
  - Test 1 ("uses tab.raw …") fails: `content === 'hello world'` (or whatever the pre-existing test path returns) — the live tab is ignored.
  - Test 2 ("falls back to getPost …") passes by accident (this is the existing behavior).
  - Test 3 ("updates content when …") fails: the live mutation is ignored.

This is the RED state we want.

- [ ] **Step 2.3: Commit (red state — so the failing tests are preserved across the next task's work)**

```bash
git add src/composables/vault/__tests__/useCurrentNote.test.ts
git commit -m "test(vault): cover useCurrentNote live-tab integration (red)

Three new cases:
  - live tab is preferred over getPost fallback
  - fallback to getPost when no live tab exists
  - live mutation propagates to content in real time

These are the failing tests the next task's implementation makes green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Implement the consumer in `useCurrentNote.ts`

**Files:**
- Modify: `src/composables/vault/useCurrentNote.ts`

- [ ] **Step 3.1: Add the imports**

In `src/composables/vault/useCurrentNote.ts`, replace the `import { getPost } from '../../lib/api'` line (line 14) with:

```ts
import { getPost } from '../../lib/api'
import { getLiveTabs, __resetLiveTabsForTesting as _resetLiveTabs } from './useEditorTabs.js'
```

(Alias the reset to `_resetLiveTabs` to avoid clashing with the existing `__resetForTesting` for the `useCurrentNote` singleton. We don't need to re-export it from this file; the test imports `__resetLiveTabsForTesting` directly from `useEditorTabs`.)

- [ ] **Step 3.2: Update the singleton's `__resetForTesting` to also reset the live-tabs ref**

Replace the existing `__resetForTesting` function (lines 23-26) with:

```ts
// Test-only escape hatch.
export function __resetForTesting(): void {
  _state = null
  _resetLiveTabs()
}
```

- [ ] **Step 3.3: Replace the inline watcher with the new resolution helper**

In `useCurrentNote()` (lines 35-62), replace the entire `watch(…)` block (lines 41-58) with:

```ts
  const liveTabs = getLiveTabs()

  // Resolve content for a given path. Two-tier fallback:
  //   1. Live editor buffer (tab.raw) if a tab is open for this path
  //      and has finished loading. This is what the user has actually
  //      typed, including unsaved keystrokes.
  //   2. getPost() — the server-saved version. Used for deep links to
  //      notes that haven't been opened in a tab yet, and when
  //      useEditorTabs has never been mounted in this session.
  async function resolveContent(p: string): Promise<string> {
    const tab = liveTabs?.value.find((t) => t.path === p)
    if (tab && !tab.loading) return tab.raw
    try {
      const post = await getPost(p)
      return post.content
    } catch {
      return ''
    }
  }

  watch(
    [() => route.params.path, liveTabs],
    async () => {
      const p = pathFromRoute(route)
      path.value = p
      if (!p) {
        content.value = ''
        return
      }
      content.value = await resolveContent(p)
    },
    { immediate: true, deep: true },
  )
```

(The `pathFromRoute` helper at line 28 and the rest of `useCurrentNote()` are unchanged. The function still returns `{ path, content }` at line 60 — the public `CurrentNote` interface is identical.)

- [ ] **Step 3.4: Run `useCurrentNote` tests, expect green**

Run: `pnpm test src/composables/vault/__tests__/useCurrentNote.test.ts`
Expected: all 7 tests pass (4 pre-existing + 3 new).

- [ ] **Step 3.5: Run `useEditorTabs` tests, expect green**

Run: `pnpm test src/composables/vault/__tests__/useEditorTabs.test.ts`
Expected: all tests pass, including the 3 from Task 1. The Task 1 test exercises the publish + mirror behavior, and the existing tests are unchanged.

- [ ] **Step 3.6: Commit**

```bash
git add src/composables/vault/useCurrentNote.ts
git commit -m "feat(vault): useCurrentNote prefers live tab.raw over getPost

Watches the live tabs ref published by useEditorTabs and resolves
content from tab.raw when a matching tab is open. Falls back to
getPost for deep links to unopened notes (and when useEditorTabs
has never been mounted). Closes the known limitation called out in
useCurrentNote.ts:5-11.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Run the full test suite + final smoke

**Files:** (no file changes)

- [ ] **Step 4.1: Run the full client test suite**

Run: `pnpm test`
Expected: 226 tests pass (223 pre-existing + 3 new in `useCurrentNote.test.ts`).

If the count is different (e.g. the pre-existing test file had a different baseline), the goal is: **zero failing tests, every previously-green test still green**.

- [ ] **Step 4.2: Manual smoke test (optional but recommended)**

1. Run `pnpm dev`.
2. Open a note in the vault editor.
3. Type a sentence that is **not yet auto-saved** (within the 800ms debounce window, or just hold off on saving).
4. Open the AI panel, ask "What did I just type in the open note?".
5. Expected: the response quotes the unsaved text. (Before this change, the model would see the pre-edit content.)

- [ ] **Step 4.3: If everything is green, do not commit — the work is already in two commits (Task 1 + Tasks 2+3). If any cleanup was needed, commit it separately:**

```bash
git status --short
# If clean, nothing to do.
# If there are stray edits, commit them as a fixup:
git add <files>
git commit -m "chore: cleanup from ai-live-note-context plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Coverage map (spec → tasks)

| Spec requirement | Task |
|---|---|
| Module-level `_liveTabs: ShallowRef<Tab[]>` owned by `useEditorTabs` | Task 1.3, 1.4 |
| `getLiveTabs()` + `__setLiveTabsForTesting()` + `__resetLiveTabsForTesting()` exports | Task 1.3 |
| Mirror via `watch(tabs, …, { flush: 'post' })` | Task 1.4 |
| `useCurrentNote.resolveContent()` — live first, `getPost` fallback | Task 3.3 |
| `watch([routePath, liveTabs], …, { deep: true })` | Task 3.3 |
| `__resetForTesting` clears `_state` AND the live-tabs ref | Task 3.2 |
| Test: live tab hit | Task 2.1 |
| Test: fallback when no live tab | Task 2.1 |
| Test: live mutation propagation | Task 2.1 |
| Test: `useEditorTabs` publishes + mirrors (Task 1 covers publish) | Task 1.1 |
| Server unchanged | (no task) ✓ |
| No new files | (no task) ✓ |

## Self-review checklist

- [x] No placeholders. Every step has the actual code or command.
- [x] Type consistency: `ShallowRef<Tab[]>` is used in both producer and consumer. `Tab` matches `src/components/vault/tabs.ts`. `getLiveTabs`/`__setLiveTabsForTesting`/`__resetLiveTabsForTesting` defined in Task 1 and consumed in Tasks 2/3.
- [x] Spec coverage: every requirement in `2026-06-07-ai-live-note-context.md` maps to a task above.
- [x] DRY: tests reuse the existing `mountAtRoute` helper; no test-only edits to the production watcher that would diverge.
- [x] YAGNI: no selection-aware, no RAG, no vault overview — all out-of-scope per spec.
- [x] Frequent commits: 3 commits total (Task 1 = publish API, Task 2 = red tests, Task 3 = green consumer).
- [x] Tests can run independently per file.
- [x] No destructive actions; no DB changes; no migrations.
