import type { Tab } from '../../../components/vault/tabs'

/* Tab-count limits. vault is a personal knowledge base — heavy
   multi-tab editing (20+ tabs) signals the user should be using
   command palette / search, not cycling through tabs. */
export const TAB_SOFT_LIMIT = 6
export const TAB_HARD_LIMIT = 9

export function makeEmptyTab(path: string, title = ''): Tab {
  return {
    path,
    documentId: null,
    title: title || path,
    raw: '',
    originalRaw: '',
    revision: 0,
    savedRevision: 0,
    savingRevision: null,
    saveStatus: 'idle',
    error: null,
    loadError: null,
    loading: true,
    serverMtime: 0,
    externalRaw: null,
    externalKind: null,
  }
}

export function pathToUrl(path: string): string {
  return '/vault/' + path
}
