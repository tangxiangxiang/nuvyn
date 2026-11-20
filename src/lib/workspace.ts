import type { ScopeKey } from '../../shared/scopeProtocol'

export type WorkspaceKind = 'vault' | 'ledger' | 'board' | 'diary' | null

export type ChromeStyle = 'workspace' | 'immersive'

export type WorkspaceNavigationKey = ScopeKey | 'board'
export type WorkspaceNavigationViewport = 'desktop' | 'compact'

/** Stable Chinese names used by the visible workspace navigation. */
export const workspaceDisplayNames = {
  note: '笔记',
  diary: '日程',
  ledger: '账本',
  board: '白板',
} as const satisfies Record<WorkspaceNavigationKey, string>

/**
 * Navigation availability is deliberately separate from route/runtime
 * availability: every workspace remains directly addressable in compact mode.
 */
export const workspaceNavigationAvailability = {
  note: { desktop: true, compact: true },
  diary: { desktop: true, compact: true },
  ledger: { desktop: true, compact: true },
  board: { desktop: true, compact: true },
} as const satisfies Record<
  WorkspaceNavigationKey,
  Record<WorkspaceNavigationViewport, boolean>
>

/** Phone-specific width used by phone-only layout rules. */
export const workspaceMobileNavigationQuery = '(max-width: 600px)'
/** Use a single current-workspace menu on both phones and tablets. */
export const workspaceCompactNavigationQuery = '(max-width: 1199px)'
export const workspaceNoteTabletQuery = '(min-width: 601px) and (max-width: 1199px)'
// Note reuses the established tablet presentation on phones without changing
// the tablet-only Diary pull-to-refresh behavior.
export const workspaceNoteCompactQuery = '(max-width: 1199px)'

export function isWorkspaceNavigationAvailable(
  workspace: WorkspaceNavigationKey,
  viewport: WorkspaceNavigationViewport,
): boolean {
  return workspaceNavigationAvailability[workspace][viewport]
}

export function workspaceKindForPath(path: string): WorkspaceKind {
  if (path === '/diary') return 'diary'
  if (path === '/board' || path.startsWith('/board/')) return 'board'
  if (path === '/ledger' || path.startsWith('/ledger/')) return 'ledger'
  if (path === '/vault' || path.startsWith('/vault/')) return 'vault'
  return null
}
