// Client-side link index store. Each Vault file-change capability owns a
// snapshot of the server's `/api/links/index`, so the wiki
// link renderer can check existence and the LinksPanel can show
// outgoing links without round-tripping the server for every note.
//
// Refresh triggers:
//   - On mount (via `useLinkIndexSubscription`)
//   - On every file-change bus event, debounced 400ms. Coalesces
//     bursts of saves (e.g. AI tool calls) into a single fetch.
//
// The bus subscription is set up ONCE per vault mount, not per
// component — duplicate watchers would each trigger a refresh.
//
// Modeled on the `_liveTabs` / `_openPost` patterns in
// useEditorTabs.ts.

import { onBeforeUnmount, onMounted, shallowRef, watch, type ShallowRef } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import {
  getBacklinks,
  getLinkIndexSnapshot,
  type BacklinkRecord,
  type LinkIndexSnapshot,
} from '../../lib/api'
import { getFallbackVaultFileChanges, type VaultFileChanges } from './context/fileChanges'
import { useOptionalVaultContext } from './context/useVaultContext'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'

// Module-level state: a single shallowRef shared by every
// component. `paths` is a Set for O(1) existence checks; `outgoing`
// is the raw wire shape (Record<source, Link[]>) so the panel can
// iterate without a second conversion pass.
export interface LinkIndexState {
  paths: Set<string>
  outgoing: Record<string, Array<{ target: string; alias?: string; anchor?: string; kind: 'wiki' | 'md' }>>
  titles: Record<string, string>
  /** Unix ms of the last successful refresh, for diagnostics. */
  lastFetched: number
}

interface LinkIndexStore {
  state: ShallowRef<LinkIndexState>
  activeStop: (() => void) | null
  subInstallCount: number
  generation: number
}

let stores = new WeakMap<VaultFileChanges, LinkIndexStore>()

function makeInitialState(): LinkIndexState {
  return { paths: new Set(), outgoing: {}, titles: {}, lastFetched: 0 }
}

function resolveFileChanges(explicit?: VaultFileChanges): VaultFileChanges {
  return explicit ?? useOptionalVaultContext()?.fileChanges ?? getFallbackVaultFileChanges()
}

function getStore(fileChanges?: VaultFileChanges): LinkIndexStore {
  const owner = resolveFileChanges(fileChanges)
  let store = stores.get(owner)
  if (!store) {
    store = { state: shallowRef(makeInitialState()), activeStop: null, subInstallCount: 0, generation: 0 }
    stores.set(owner, store)
  }
  return store
}

export function getLinkIndex(fileChanges?: VaultFileChanges): ShallowRef<LinkIndexState> {
  return getStore(fileChanges).state
}

/** Force a fresh fetch from `/api/links/index`. Called on mount and
 *  from the debounced bus subscriber. Errors are swallowed: a
 *  transient network failure just leaves the previous state in
 *  place; the next bus event will retry. */
export async function refreshLinkIndex(fileChanges?: VaultFileChanges): Promise<void> {
  const owner = resolveFileChanges(fileChanges)
  const store = getStore(owner)
  const generation = store.generation
  try {
    const snap: LinkIndexSnapshot = await getLinkIndexSnapshot()
    if (store.generation !== generation) return
    const outgoing = Object.fromEntries(Object.entries(snap.outgoing ?? {})
      .filter(([source]) => !isManagedDiaryPath(source))
      .map(([source, links]) => [source, links.filter((link) => !isManagedDiaryPath(link.target))]))
    const titles = Object.fromEntries(Object.entries(snap.titles ?? {}).map(([path, title]) => [
      path,
      isManagedDiaryPath(path) ? (path.split('/').pop() ?? path) : title,
    ]))
    const next: LinkIndexState = {
      paths: new Set(snap.paths),
      outgoing,
      titles,
      lastFetched: Date.now(),
    }
    // Always initialize this Vault's store (so a refresh called before
    // any consumer reads `getLinkIndex()` still produces state).
    getLinkIndex(fileChanges).value = next
  } catch {
    // ignore — keep the previous state
  }
}

/** Synchronously drop all body-derived client index state for this vault.
 * A generation fence makes any in-flight response captured before lock a
 * no-op when it resolves. */
export function clearLinkIndex(fileChanges?: VaultFileChanges): void {
  const store = getStore(fileChanges)
  store.generation += 1
  store.state.value = makeInitialState()
}

/** Test-only escape hatch: drop the legacy fallback so the next
 *  `getLinkIndex()` returns a fresh empty state. */
export function __resetLinkIndexForTesting(): void {
  const legacyFileChanges = getFallbackVaultFileChanges()
  const store = stores.get(legacyFileChanges)
  store?.activeStop?.()
  stores.delete(legacyFileChanges)
}

// --- bus subscription (one per vault mount) ---

/** Install the file-change-bus subscription that refreshes the
 *  link index on every external change. Each call installs a
 *  fresh watch; the previous one is torn down if still active
 *  (e.g. across remounts in tests). */
export function useLinkIndexSubscription(fileChanges?: VaultFileChanges): void {
  const owner = resolveFileChanges(fileChanges)
  const store = getStore(owner)
  // Tear down any prior subscription so multiple mounts (e.g.
  // across test cases) each get their own watcher + debounce.
  if (store.activeStop) {
    store.activeStop()
    store.activeStop = null
  }

  const bus = owner.events
  // Debounce: a save-burst (e.g. an AI tool call) can publish
  // multiple events in a few ms. Coalesce them into one refresh.
  const debounced = useDebounceFn(() => { void refreshLinkIndex(owner) }, 400)

  let lastSeenSeq = 0
  const stop = watch(
    () => bus.value,
    (events) => {
      const latest = events.at(-1)?.seq ?? lastSeenSeq
      if (latest <= lastSeenSeq) return
      lastSeenSeq = latest
      debounced()
    },
    { flush: 'post' },
  )

  const cleanup = () => {
    stop()
    // Cancel any pending debounced refresh so a mid-flight debounce
    // can't fire after the watch is torn down. useDebounceFn exposes
    // cancel as a property on the returned function; if the version
    // shipped with the project doesn't have it, we degrade gracefully
    // (the in-flight refresh will just no-op against a reset state).
    const d = debounced as { cancel?: () => void }
    d.cancel?.()
  }
  store.activeStop = cleanup
  store.subInstallCount += 1

  // First refresh: do it immediately (no debounce) so the index is
  // populated before the user opens the first note.
  onMounted(() => { void refreshLinkIndex(owner) })

  onBeforeUnmount(() => {
    if (store.activeStop === cleanup) {
      cleanup()
      store.activeStop = null
    }
  })
}

/** Test-only escape hatch: reset subscription install count. */
export function __resetLinkIndexSubscriptionForTesting(): void {
  const legacyFileChanges = getFallbackVaultFileChanges()
  const store = stores.get(legacyFileChanges)
  if (store?.activeStop) {
    store.activeStop()
    store.activeStop = null
  }
  if (store) store.subInstallCount = 0
}

// Backlinks are NOT in the index snapshot (they'd bloat the wire
// shape for notes with many incoming links). Fetched on demand
// per-path. The LinksPanel calls this when its `path` prop changes.
export async function fetchBacklinks(path: string): Promise<BacklinkRecord[]> {
  if (isManagedDiaryPath(path.replace(/\.md$/, ''))) return []
  return getBacklinks(path)
}
