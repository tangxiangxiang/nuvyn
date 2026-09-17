/** Canonical browser-side technical identifiers owned by the Nuvyn runtime. */

export const NUVYN_BROWSER_STORAGE_KEYS = {
  theme: 'nuvyn.theme',
  vaultViewMode: 'nuvyn.vault.viewMode',
  vaultExpandedPaths: 'nuvyn.vault.expandedPaths',
  vaultActiveScope: 'nuvyn.vault.activeScope',
  vaultLayout: 'nuvyn.vault.layout',
  boardFavorites: 'nuvyn.board.favorites',
  ledgerCategoryIcons: 'nuvyn.ledger.category-icons',
  ledgerCategoryCustomIcons: 'nuvyn.ledger.category-custom-icons',
  ledgerAccountIconCustom: 'nuvyn.ledger.account-icon.custom',
  ledgerAccountIconNames: 'nuvyn.ledger.account-icon.names',
  ledgerAccountIconAvailable: 'nuvyn.ledger.account-icon.available',
  ledgerAccountIconDefault: 'nuvyn.ledger.account-icon.default',
  ledgerPendingCreate: 'nuvyn.ledger.pending-create',
  editorFocusWidth: 'nuvyn.editor.focus-width',
  editorFontSize: 'nuvyn.editor.font-size',
  editorLineHeight: 'nuvyn.editor.line-height',
  editorTabSize: 'nuvyn.editor.tab-size',
  editorWrapColumn: 'nuvyn.editor.wrap-column',
  editorFontFamily: 'nuvyn.editor.font-family',
  editorTypography: 'nuvyn.editor.typography',
  editorMonacoViewState: 'nuvyn.monaco.view-state',
  editorRecentWikiLinks: 'nuvyn.monaco.recent-wiki-links',
  fileTreeCompact: 'nuvyn.file-tree.compact',
  fileTreeFilter: 'nuvyn.file-tree.filter',
  diaryFilterSeed: 'nuvyn.diary.filter-seed',
  diaryFilterOwnership: 'nuvyn.diary.filter-ownership',
} as const

export const NUVYN_DRAFT_DATABASE_NAME = 'nuvyn-draft-recovery'
export const NUVYN_BOARD_RECOVERY_DATABASE_NAME = 'nuvyn-board-recovery'
export const NUVYN_BOARD_LIBRARY_DATABASE_NAME = 'nuvyn-board-library'

export function nuvynScopedTabStorageKey(vaultId: string): string {
  return `nuvyn:tabs:v1:${vaultId}`
}

export function nuvynBoardDragMime(kind: 'board-id' | 'path' | 'kind'): string {
  const suffix = kind === 'board-id' ? 'board-id' : kind
  return `text/x-nuvyn-${suffix}`
}

export function readDataTransfer(
  transfer: DataTransfer | null | undefined,
  mime: string,
): string {
  if (!transfer) return ''
  try {
    return transfer.getData(mime)
  } catch {
    return ''
  }
}

export function nuvynWorkspaceTabMime(): string {
  return 'application/x-nuvyn-workspace-tab'
}

export function nuvynMonacoTheme(theme: 'light' | 'dark'): string {
  return `nuvyn-${theme}`
}

export type BrowserStorageKey = string

export function readStorageKey(
  storageKey: BrowserStorageKey,
  storage: Storage | null = storageOrNull(),
  isValid: (raw: string) => boolean = () => true,
): string | null {
  if (!storage) return null
  try {
    const value = storage.getItem(storageKey)
    return value !== null && isValid(value) ? value : null
  } catch {
    return null
  }
}

export function writeStorageKey(
  storageKey: BrowserStorageKey,
  value: string,
  storage: Storage | null = storageOrNull(),
): void {
  if (!storage) return
  try { storage.setItem(storageKey, value) } catch { /* best effort */ }
}

export function removeStorageKey(
  storageKey: BrowserStorageKey,
  storage: Storage | null = storageOrNull(),
): void {
  if (!storage) return
  try { storage.removeItem(storageKey) } catch { /* best effort */ }
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export async function existingIndexedDbNames(factory: IDBFactory): Promise<Set<string> | null> {
  const databases = (factory as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string | null }>>
  }).databases
  if (typeof databases !== 'function') return null
  try {
    const rows = await databases.call(factory)
    return new Set(rows.map((row) => row.name).filter((name): name is string => Boolean(name)))
  } catch {
    return null
  }
}

export function openNamedIndexedDb(
  factory: IDBFactory,
  name: string,
  version: number | undefined,
  onUpgrade: (request: IDBOpenDBRequest) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    let blocked = false
    let settled = false
    try {
      request = factory.open(name, version)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => onUpgrade(request)
    request.onsuccess = () => {
      if (blocked || settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error ?? new Error('IndexedDB open failed'))
    }
    request.onblocked = () => {
      if (settled) return
      blocked = true
      settled = true
      reject(new Error('IndexedDB open was blocked'))
    }
  })
}
