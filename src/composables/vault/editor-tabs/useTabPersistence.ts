import { useDebounceFn } from '@vueuse/core'
import { ref, watch, type Ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'
import { readStorageKey, nuvynScopedTabStorageKey, writeStorageKey, type BrowserStorageKey } from '../../../technicalNamespace'

const TAB_PERSIST_MAX = 20
const TAB_PERSIST_DEBOUNCE_MS = 100

let vaultIdOverrideForTesting: string | undefined

export interface PersistedTabs {
  v: number
  paths: string[]
  active: string | null
}

function storageKey(vaultId: string): BrowserStorageKey {
  if (typeof vaultId !== 'string' || vaultId.length === 0) {
    throw new Error('Vault identity is required for tab persistence.')
  }
  return nuvynScopedTabStorageKey(vaultId)
}

export function readPersistedTabs(vaultId: string): PersistedTabs | null {
  let raw: string | null
  try { raw = readStorageKey(storageKey(vaultId)) } catch { return null }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null
        && (parsed as { v?: unknown }).v === 1
        && Array.isArray((parsed as { paths?: unknown }).paths)) {
      const paths = (parsed as { paths: unknown[] }).paths
        .filter((p): p is string => typeof p === 'string')
        .slice(0, TAB_PERSIST_MAX)
      const rawActive = (parsed as { active?: unknown }).active
      return { v: 1, paths, active: typeof rawActive === 'string' ? rawActive : null }
    }
  } catch { /* corrupt JSON is treated as empty */ }
  return null
}

function writePersistedTabs(tabs: Tab[], active: string | null, vaultId: string) {
  try {
    const data: PersistedTabs = {
      v: 1,
      paths: tabs.map((t) => t.path).slice(0, TAB_PERSIST_MAX),
      active,
    }
    writeStorageKey(storageKey(vaultId), JSON.stringify(data))
  } catch { /* persistence is best-effort */ }
}

/**
 * Synchronous + debounced tab-set persistence.
 *
 * Returns:
 *   - `vaultId`: the already-resolved authoritative identity supplied by
 *     the workspace gate.
 *   - `persist`: a SYNCHRONOUS writer. Every close / rename /
 *     restore-failure mutation calls this so a page refresh before
 *     the debounce flushes cannot resurrect a closed tab. This is
 *     also called on `beforeunload` so the user closing the tab
 *     keeps the latest state.
 *   - the debounced watcher is wired internally; callers don't need
 *     to touch it.
 */
export function useTabPersistence(
  tabs: Ref<Tab[]>,
  activePath: Ref<string | null>,
  authoritativeVaultId: string,
) {
  const vaultId = ref<string>(vaultIdOverrideForTesting ?? authoritativeVaultId)
  // Keep the production path fail-closed even if a JavaScript caller bypasses
  // the TypeScript contract with an empty value.
  storageKey(vaultId.value)
  let disposed = false

  function persist(): void {
    writePersistedTabs(tabs.value, activePath.value, vaultId.value)
  }

  const debouncedPersist = useDebounceFn(() => {
    if (!disposed) persist()
  }, TAB_PERSIST_DEBOUNCE_MS)
  const stopWatch = watch([tabs, activePath], () => { debouncedPersist() }, { deep: false })

  // Flush synchronously before teardown. dispose() marks the instance
  // inactive so a trailing debounce callback cannot overwrite storage
  // after another Vault instance has mounted.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', persist)
  }

  function dispose(): void {
    if (disposed) return
    persist()
    disposed = true
    stopWatch()
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', persist)
    }
  }

  return { vaultId, persist, dispose }
}

export function __setVaultIdForTesting(vaultId: string): void {
  vaultIdOverrideForTesting = vaultId
}

export function resetTabPersistenceForTesting(): void {
  vaultIdOverrideForTesting = undefined
}
