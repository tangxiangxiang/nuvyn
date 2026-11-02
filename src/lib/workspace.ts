import type { ScopeKey } from '../../shared/scopeProtocol'

export type WorkspaceKind = 'vault' | 'ledger' | 'board' | null

export type ChromeStyle = 'workspace' | 'immersive'

export type WorkspaceNavigationKey = ScopeKey | 'board'
export type WorkspaceNavigationViewport = 'desktop' | 'mobile'

/**
 * Navigation availability is deliberately separate from route/runtime
 * availability: every workspace remains directly addressable on mobile.
 */
export const workspaceNavigationAvailability = {
  note: { desktop: true, mobile: true },
  diary: { desktop: true, mobile: true },
  ledger: { desktop: true, mobile: true },
  board: { desktop: true, mobile: true },
} as const satisfies Record<
  WorkspaceNavigationKey,
  Record<WorkspaceNavigationViewport, boolean>
>

/** Keep the nav's responsive behavior on Diary's existing 600px boundary. */
export const workspaceMobileNavigationQuery = '(max-width: 600px)'
export const workspaceNoteTabletQuery = '(min-width: 601px) and (max-width: 1199px)'
// Note reuses the established tablet presentation on phones without changing
// the tablet-only Diary pull-to-refresh and shared mobile navigation boundary.
export const workspaceNoteCompactQuery = '(max-width: 1199px)'

export function isWorkspaceNavigationAvailable(
  workspace: WorkspaceNavigationKey,
  viewport: WorkspaceNavigationViewport,
): boolean {
  return workspaceNavigationAvailability[workspace][viewport]
}

export function workspaceKindForPath(path: string): WorkspaceKind {
  if (path === '/board' || path.startsWith('/board/')) return 'board'
  if (path === '/ledger' || path.startsWith('/ledger/')) return 'ledger'
  if (path === '/vault' || path.startsWith('/vault/')) return 'vault'
  return null
}
