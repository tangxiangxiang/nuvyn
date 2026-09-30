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
  note: { desktop: true, mobile: false },
  diary: { desktop: true, mobile: true },
  ledger: { desktop: true, mobile: true },
  board: { desktop: true, mobile: false },
} as const satisfies Record<
  WorkspaceNavigationKey,
  Record<WorkspaceNavigationViewport, boolean>
>

/** Keep the nav's responsive behavior on Diary's existing 600px boundary. */
export const workspaceMobileNavigationQuery = '(max-width: 600px)'

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
