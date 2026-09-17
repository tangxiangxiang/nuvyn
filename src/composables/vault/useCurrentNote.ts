// Legacy route-note state. Tracks the note named by the ROUTE and
// mirrors a best-effort content string for it. Per-VaultContext
// singleton (like useAiHistory) so components in the same vault agree
// on what the route currently names.
//
// Since Edit-10.2 this composable is NO LONGER the AI context
// authority: the AI panel captures the active WORKSPACE tab through
// `useAiLiveContext` (Document / History / Diff / Recovery), and the
// route is at most one input to the workspace's own active tab id.
// Do not add new AI-send consumers here — a route path can lag the
// workspace (history/recovery active, rename in flight) and must
// never be spliced with live content.
//
// Known limitation: `content` is a convenience mirror, not a certified
// snapshot — it prefers the live editor buffer when a tab is open and
// falls back to the server-saved version otherwise, with the
// file-change bus subscription keeping it in sync with writes made by
// the AI's own tools (write_file / patch_file / rename_file).
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useRoute, type RouteLocationNormalizedLoaded } from 'vue-router'
import { getPost } from '../../lib/api'
import { getFallbackVaultFileChanges } from './context/fileChanges'
import { useOptionalVaultContext } from './context/useVaultContext'
import type { VaultContext } from './context/types'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent, subscribeDiaryTeardown } from '../diary/useDiaryAccessSession'

export interface CurrentNote {
  path: Ref<string | null>
  content: Ref<string>
}

let stateByContext = new WeakMap<VaultContext, CurrentNote>()
let fallbackState: CurrentNote | null = null

// Test-only escape hatch.
export function __resetForTesting(): void {
  stateByContext = new WeakMap()
  fallbackState = null
}

function pathFromRoute(route: RouteLocationNormalizedLoaded): string | null {
  // The production router declares TWO vault routes (see src/router/index.ts):
  //   - 'vault'      for the /vault index (no path)
  //   - 'vault-doc'  for /vault/:pathMatch(.*)* (a path-bearing URL)
  // Either way, when a document is open, the path is in params.pathMatch.
  // Some tests still use a single 'vault' route with a 'path' param — we
  // accept both param names for the same reason.
  if (route.name !== 'vault' && route.name !== 'vault-doc') return null
  const splat = (route.params.path ?? route.params.pathMatch) as
    | string | string[] | undefined
  if (!splat) return null
  return Array.isArray(splat) ? splat.join('/') : splat
}

export function useCurrentNote(): CurrentNote {
  const vaultContext = useOptionalVaultContext()
  const existing = vaultContext ? stateByContext.get(vaultContext) : fallbackState
  if (existing) return existing
  const route = useRoute()
  const path = ref<string | null>(null)
  const content = ref<string>('')

  const liveTabs = vaultContext?.editor.tabs
  const fileBus = vaultContext?.fileChanges.events ?? getFallbackVaultFileChanges().events

  // Resolve content for a given path. Two-tier fallback:
  //   1. Live editor buffer (tab.raw) if a tab is open for this path
  //      and has finished loading. This is what the user has actually
  //      typed, including unsaved keystrokes.
  //   2. getPost() — the server-saved version. Used for deep links to
  //      notes that haven't been opened in a tab yet, and when
  //      useEditorTabs has never been mounted in this session.
  async function resolveContent(p: string): Promise<string> {
    const contextContent = vaultContext?.editor.getLiveContent(p)
    if (contextContent !== null && contextContent !== undefined) return contextContent
    const tab = liveTabs?.value.find((t) => t.path === p)
    // Managed Diary bodies are never read from a generic tab mirror.  If the
    // route mirror needs a body, go back through the existing authenticated
    // GET/adapter path; a locked or expired capability therefore returns an
    // empty mirror instead of exposing tab.raw through this secondary seam.
    if (isManagedDiaryPath(p)) {
      try {
        const post = await getPost(p)
        return post.content
      } catch {
        return ''
      }
    }
    if (tab && !tab.loading) return tab.raw
    try {
      const post = await getPost(p)
      return post.content
    } catch {
      return ''
    }
  }

  const stopTeardown = subscribeDiaryTeardown(() => {
    if (isManagedDiaryPath(path.value ?? '')) content.value = ''
  })
  onBeforeUnmount(stopTeardown)

  watch(
    // fullPath is the safest source: it's a string that vue-router
    // guarantees changes whenever the URL changes, regardless of which
    // route record matched or which splat param name it used. The
    // earlier `() => route.params.path` source was undefined in
    // production (the splat param is named `pathMatch`), so the watch
    // never re-fired on navigation.
    [() => route.fullPath, liveTabs],
    async () => {
      const p = pathFromRoute(route)
      path.value = p
      if (!p) {
        content.value = ''
        return
      }
      const managed = isManagedDiaryPath(p)
      const requestGeneration = managed ? captureDiarySessionGeneration() : null
      const resolved = await resolveContent(p)
      if (requestGeneration !== null && !isDiarySessionGenerationCurrent(requestGeneration)) return
      content.value = resolved
    },
    { immediate: true, deep: true },
  )

  // Mirror AI file-writes into `content` so any consumer reading the
  // route note sees the AI's own edits (write_file / patch_file /
  // rename_file) without a manual refresh. Only the route note is
  // mirrored. This mirror predates Edit-10 and is NOT the AI send
  // path — the AI panel captures the active workspace tab through
  // useAiLiveContext instead.
  let lastSeenSeq = 0
  watch(
    () => fileBus.value,
    (events) => {
      const p = path.value
      if (!p) return
      // Managed Diary route bodies are owned by the editor/adapter; the
      // generic mirror must not rehydrate them from a late bus event.
      if (isManagedDiaryPath(p)) return
      for (const e of events) {
        if (e.seq <= lastSeenSeq) continue
        if (
          (e.source === 'history-restore' || e.source === 'editor-lifecycle')
          && e.kind === 'write'
          && e.path === p
        ) {
          const live = vaultContext?.editor.getLiveContent(p)
          content.value = live ?? e.newRaw ?? ''
        } else if (e.kind === 'write' && e.path === p && e.newRaw != null) {
          content.value = e.newRaw
        } else if (e.kind === 'rename' && e.path === p && e.newRaw != null) {
          // The active path was just renamed; the route is
          // expected to follow, but the content update is the
          // important part for any in-flight reads.
          content.value = e.newRaw
        }
      }
      lastSeenSeq = events.at(-1)?.seq ?? lastSeenSeq
    },
    { flush: 'post' },
  )

  const state = { path, content }
  if (vaultContext) stateByContext.set(vaultContext, state)
  else fallbackState = state
  return state
}
