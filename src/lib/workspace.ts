export type WorkspaceKind = 'vault' | 'ledger' | 'board' | null

export type ChromeStyle = 'workspace' | 'immersive'

export function workspaceKindForPath(path: string): WorkspaceKind {
  if (path === '/board' || path.startsWith('/board/')) return 'board'
  if (path === '/ledger' || path.startsWith('/ledger/')) return 'ledger'
  if (path === '/vault' || path.startsWith('/vault/')) return 'vault'
  return null
}
