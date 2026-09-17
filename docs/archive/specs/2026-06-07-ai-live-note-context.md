> **SUPERSEDED (2026-07-21).** The pipeline below (module-level `_liveTabs` → `useCurrentNote.content` → `currentNoteContent` in the POST body) was never implemented and no longer matches the codebase: `VaultContext` replaced the singleton, `AiPanel` only ever sent `currentNote.path`, and the workspace now hosts document/history/diff/recovery tabs. The live workspace context contract is defined in [2026-07-21-ai-live-workspace-context.md](./2026-07-21-ai-live-workspace-context.md) (Edit-10). Retained for historical reference only.

# AI Live Note Context

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI panel send the *live editor buffer* (not the last server-saved snapshot) as `currentNoteContent`, so freshly typed text shows up in the model's context immediately.

**Architecture:** Add a module-level `liveTabs` ref that `useEditorTabs` publishes to once on init. `useCurrentNote` watches it and prefers `tab.raw` over its existing `getPost` fallback. Server-side `buildSystemPrompt` is unchanged — it already correctly handles whatever `currentNoteContent` it receives.

**Tech Stack:** Vue 3 (`ref`, `watch`, `computed`), Vitest, existing singleton-with-`__resetForTesting` test pattern.

---

## Problem

`useCurrentNote` ([src/composables/vault/useCurrentNote.ts:42-58](../../../src/composables/vault/useCurrentNote.ts)) reads the active note's content from the server via `getPost(path)`. The server's view is at most 800ms behind the editor (the `doSave` debounce in [useEditorTabs.ts:171-173](../../../src/composables/vault/useEditorTabs.ts)), and **always behind while the user is mid-keystroke or before the first save lands**. The `useEditorTabs` composable already keeps a per-tab `tab.raw` ref that updates on every keystroke (the debounce is only on `doSave`, not on the buffer), but `useCurrentNote` never reads it.

This is a known limitation, called out in the existing code comment at [useCurrentNote.ts:5-11](../../../src/composables/vault/useCurrentNote.ts):

> Known limitation (see spec §3.7): the content is the SERVER-SAVED version, not the editor's live unsaved buffer.

This spec closes that gap.

## Solution

### Component 1: `liveTabs` module-level ref (in `useEditorTabs.ts`)

A module-level `Ref<Tab[]>` (or `shallowRef` for perf — `Tab` array changes are full replacements, not in-place mutations, so `shallowRef` is enough) that `useEditorTabs` publishes to on first call. Exported as a `getLiveTabs()` getter that returns the ref, or `null` if `useEditorTabs` has not been initialized in this session.

```ts
// src/composables/vault/useEditorTabs.ts
import { shallowRef, type ShallowRef } from 'vue'
// ... existing imports

let _liveTabs: ShallowRef<Tab[]> | null = null

/** Test-only escape hatch. */
export function __resetLiveTabsForTesting(): void {
  _liveTabs = null
}

/** Get the live-tabs ref published by useEditorTabs, or null if it
 *  hasn't been mounted yet (e.g. the AI panel is being used outside
 *  a vault view that mounts useEditorTabs). */
export function getLiveTabs(): ShallowRef<Tab[]> | null {
  return _liveTabs
}

// ... inside useEditorTabs(), right after `const tabs = ref<Tab[]>([])`:
_liveTabs = _liveTabs ?? shallowRef<Tab[]>([])
// Mirror mutations: keep _liveTabs.value === tabs.value.
watch(tabs, (v) => { if (_liveTabs) _liveTabs.value = v }, { flush: 'post' })
```

Notes on the design choices:

- **`shallowRef`, not `ref`** — `tabs.value` is always replaced wholesale (`tabs.value = [...tabs.value, newTab]` or `tabs.value.splice(...)`); the array's contents are read-only on the consumer side. `shallowRef` skips the per-element reactivity overhead, and we still get notified on each replacement.
- **`_liveTabs ?? shallowRef(...)` (idempotent init)** — the singleton-with-reset pattern used by `useAiHistory` and `useCurrentNote` means the same module is re-entered across test cases. We don't want to re-create the ref on every call; the `??` makes "first call wins" and subsequent calls reuse it.
- **`flush: 'post'`** — so consumers (e.g. `useCurrentNote`) see the same value `useEditorTabs` saw, not a pre-flush snapshot. This avoids a transient where `liveTabs` and `tabs` disagree by one tick.
- **Mirror via `watch`, not by aliasing the ref** — `useEditorTabs` is a per-mount composable; its local `tabs` ref is created fresh on every call. We can't `export const liveTabs = tabs` from inside the function. The `watch` keeps the module-level mirror in lockstep.

### Component 2: `useCurrentNote` reads `liveTabs`

`useCurrentNote` becomes the consumer. The change is contained to its setup function — the public `CurrentNote` interface (`{ path, content }`) is unchanged.

Resolution order in the new `resolveContent()` helper (the existing inline watcher is replaced with this):

```ts
// src/composables/vault/useCurrentNote.ts
import { getLiveTabs, __resetLiveTabsForTesting } from './useEditorTabs.js'

// New module-level helper. Re-export from the same __tests__ file
// that already re-exports __resetForTesting.
export { __resetLiveTabsForTesting as __resetLiveTabsForTestingInUseCurrentNote }

// Inside useCurrentNote(), replace the existing watch on
// route.params.path with:

const liveTabs = getLiveTabs()

async function resolveContent(p: string): Promise<string> {
  // 1. Live tab — preferred path. The watch in useEditorTabs keeps
  //    liveTabs.value in lockstep with its local tabs, so this is the
  //    same data the editor renders.
  const tab = liveTabs?.value.find((t) => t.path === p)
  if (tab && !tab.loading) return tab.raw

  // 2. Fallback: server-saved content via the API. Used when there's
  //    no open tab (deep link to a note the user hasn't opened yet,
  //    or the AI panel is mounted in a view that doesn't mount
  //    useEditorTabs).
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

Notes:

- **`watch([...], { deep: true })`** — `liveTabs` is a `shallowRef`, so the watch needs `deep: true` to react to array replacements (technically `shallowRef` *does* trigger on `value` replacement, so `deep` is unnecessary for the array itself; but if we ever switch to `ref` for any reason, `deep: true` future-proofs it. Cost is one extra iteration per emit. Acceptable.)
- **`tab.loading` guard** — `tab.raw === ''` while the tab is being fetched. Returning `''` here matches the API fallback's "still loading" feel. The watch fires again when the tab finishes loading, so the empty content is transient.
- **`getLiveTabs()` is called once, not per-watch-fire** — module-level `liveTabs` reference is stable across the composable's lifetime; calling it again would just return the same ref.
- **Async `resolveContent`** — needed because the fallback path is an HTTP call. The `await` is fine in a `watch` callback (Vue handles the return type as `void`).

### Component 3: Tests

Three new test cases, all in `src/composables/vault/__tests__/useCurrentNote.test.ts` (the file already exists per the prior LLM-integration work — verified by the test scaffolding pattern used for `useAiHistory`).

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useCurrentNote, __resetForTesting } from '../useCurrentNote'
import {
  getLiveTabs,
  __resetLiveTabsForTesting,
} from '../useEditorTabs'

// Mock getPost so tests don't hit the network. The mock returns a
// sentinel value the assertion can compare against.
vi.mock('../../../lib/api', () => ({
  getPost: vi.fn(async (p: string) => ({ content: `server:${p}`, raw: '' })),
}))

beforeEach(() => {
  __resetForTesting()
  __resetLiveTabsForTesting()
})

function makeRouter(path: string) {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ name: 'vault', path: '/vault/:pathMatch(.*)*', component: { template: '<div/>' } }],
  }).push(`/vault/${path}`).then((r) => r)
}

describe('useCurrentNote — live tab integration', () => {
  it('uses the live tab.raw when a matching tab is open', async () => {
    const tabs = getLiveTabs()!
    tabs.value = [{ path: 'foo.md', title: 'foo', raw: 'live content', originalRaw: '', saveStatus: 'idle', error: null, loadError: null, loading: false }]
    await makeRouter('foo.md')
    const n = useCurrentNote()
    // wait for the watcher's async resolveContent
    await new Promise((r) => setTimeout(r, 0))
    expect(n.content.value).toBe('live content')
  })

  it('falls back to getPost when no live tab exists for the path', async () => {
    await makeRouter('bar.md')
    const n = useCurrentNote()
    await new Promise((r) => setTimeout(r, 0))
    expect(n.content.value).toBe('server:bar.md')
  })

  it('updates content when the live tab.raw mutates (typing)', async () => {
    const tabs = getLiveTabs()!
    tabs.value = [{ path: 'baz.md', title: 'baz', raw: 'a', originalRaw: '', saveStatus: 'idle', error: null, loadError: null, loading: false }]
    await makeRouter('baz.md')
    const n = useCurrentNote()
    await new Promise((r) => setTimeout(r, 0))
    expect(n.content.value).toBe('a')
    tabs.value = [{ ...tabs.value[0], raw: 'ab' }]
    await new Promise((r) => setTimeout(r, 0))
    expect(n.content.value).toBe('ab')
  })
})
```

The existing tests in the same file (path-only, content fallback, error path) keep working — they don't set `liveTabs`, so the watch never fires the live path, and `getPost` is called as before. To verify, the spec review runs `pnpm test src/composables/vault/__tests__/useCurrentNote.test.ts` after the change and confirms all green.

## Data flow (end-to-end)

```
User types in editor
  │  EditorPane emits update:modelValue
  ▼
VaultView handler → useEditorTabs.onEditorChange(path, raw)
  │  tab.raw mutated (no debounce on the buffer)
  ▼
useEditorTabs' local tabs ref replaced
  │  watch(tabs, …) flush:post
  ▼
_liveTabs.value = new array   ◄── module-level mirror
  │
  │  watch([routePath, liveTabs], …) deep
  ▼
useCurrentNote.resolveContent(routePath)
  │  1. liveTabs.find(p).raw → "ab"
  │  2. (only if no tab) getPost(p).content
  ▼
useCurrentNote.content.value = "ab"
  │
  │  AiPanel.onSend reads currentNote.content
  ▼
POST /api/ai/chat { currentNoteContent: "ab", … }
  │
  ▼  (server unchanged)
buildSystemPrompt embeds "ab" in the system message
```

## Out of scope

- Multi-note retrieval / RAG (deferred — see [ ] in `§ Out of scope`)
- Selection-aware context
- Vault overview
- Server-side changes (`buildSystemPrompt` is correct as-is)
- `AiPanel.vue` / `useAiHistory.sendAndStream` — both already read `currentNote.content.value` and pick up the new behavior for free
- Removing the `getPost` fallback — it's the only path for un-opened deep links, and the cost is one cached HTTP call per route change

## Edge cases (revisited)

| Case | Behavior |
|---|---|
| Tab open, path matches | `content = tab.raw` |
| No tab for path (deep link) | `content = getPost(path).content` (current behavior) |
| Tab open but `tab.loading === true` | `content = ''` briefly, then the watch fires on `loading: false` |
| Tab closed | `useCurrentNote` re-watches, falls through to fallback |
| `useEditorTabs` not mounted | `liveTabs === null`, fallback path used |
| Route changes to new path | Existing route watch fires, then liveTabs watch re-fires when the new tab is created |

## Files to change

- `src/composables/vault/useEditorTabs.ts` — add module-level `liveTabs` ref + `getLiveTabs()` + `__resetLiveTabsForTesting()` (≈12 lines)
- `src/composables/vault/useCurrentNote.ts` — replace inline route watcher with `watch([routePath, liveTabs], …)` and `resolveContent()` helper (≈25 lines)
- `src/composables/vault/__tests__/useCurrentNote.test.ts` — add 3 test cases (above)

## Why not the other options

- **B (shared `useLiveBuffer` singleton)** — was the alternative. Adds a new module + a new singleton-with-reset pattern. A's module-level ref inside `useEditorTabs.ts` is the same shape with one fewer file.
- **C (`EditorPane` writes to `useCurrentNote`)** — makes the editor aware of a sibling composable. Crossing the component → composable boundary in the wrong direction. A keeps the editor dumb and the composable smart.

## Testing strategy

- Existing `useCurrentNote.test.ts` cases must keep passing.
- New 3 cases above must pass.
- Run full client test suite: `pnpm test` (currently 223 tests across the project; should grow to 226).
- Manual smoke: open the AI panel, type into a note, ask "what did I just write?" — the response should reflect the unsaved text.

## Rollout

- No DB migration, no server restart required.
- Single client-side change, hot-reload picks it up.
- No README change needed (the prior AI panel README section already mentions the `📎` chip and current-note behavior).
