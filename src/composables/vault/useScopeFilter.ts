// Scope filter for the vault's file tree. The filter narrows the tree to a
// user-facing content scope and is rendered as chips in the NavBar (the file
// tree's header is too narrow on 150px sidebars). Both the NavBar and the
// FileTree need to read this state, so it lives in a composable with
// module-level refs — a tiny singleton pattern that keeps the storage key and
// watchers in one place instead of two.

import { computed, ref, watch } from 'vue'
import { SCOPE_ROOTS, type ScopeKey } from '../../../shared/scopeProtocol'
import { NUVYN_BROWSER_STORAGE_KEYS, readStorageKey, writeStorageKey } from '../../technicalNamespace'

const STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.vaultActiveScope
const DEFAULT_SCOPE: ScopeKey = 'note'

type InitialScope = { active: ScopeKey; pendingDiaryRestore: boolean }

function loadScope(): InitialScope {
  const fallback = { active: DEFAULT_SCOPE, pendingDiaryRestore: false }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = readStorageKey(STORAGE_KEY)
    if (!raw) return fallback
    // A persisted Diary selection is a navigation preference, not an access
    // grant. Keep a safe in-memory Note scope until server authorization is
    // resolved, without overwriting the saved Diary preference in storage.
    if (raw === 'diary') return { active: DEFAULT_SCOPE, pendingDiaryRestore: true }
    if (Object.prototype.hasOwnProperty.call(SCOPE_ROOTS, raw)) {
      return { active: raw as ScopeKey, pendingDiaryRestore: false }
    }
    if (SCOPE_ROOTS.note.includes(raw as typeof SCOPE_ROOTS.note[number])) return fallback
    return fallback
  } catch {
    return fallback
  }
}

const initialScope = loadScope()
const activeScope = ref<ScopeKey>(initialScope.active)
const diaryScopeRestorePending = ref(initialScope.pendingDiaryRestore)
const workspaceRightPanelAvailable = computed(() => activeScope.value !== 'diary')
let persistenceWired = false

export function useScopeFilter() {
  if (!persistenceWired && typeof window !== 'undefined') {
    watch([activeScope, diaryScopeRestorePending], ([scope, pending]) => {
      if (!pending) writeStorageKey(STORAGE_KEY, scope)
    }, { immediate: true })
    persistenceWired = true
  }

  function selectScope(scope: ScopeKey): void {
    // Explicit navigation overrides a pending saved Diary preference.
    diaryScopeRestorePending.value = false
    if (activeScope.value === scope) return
    activeScope.value = scope
  }

  function settleDiaryScopeRestore(unlocked: boolean): void {
    // Late authorization responses must not undo an explicit scope switch.
    if (!diaryScopeRestorePending.value) return
    activeScope.value = unlocked ? 'diary' : DEFAULT_SCOPE
    diaryScopeRestorePending.value = false
  }

  return { activeScope, selectScope, diaryScopeRestorePending, settleDiaryScopeRestore, workspaceRightPanelAvailable }
}
