import { describe, expect, it } from 'vitest'
import {
  isWorkspaceNavigationAvailable,
  workspaceMobileNavigationQuery,
  workspaceNavigationAvailability,
  workspaceKindForPath,
} from '../workspace'

describe('workspace navigation availability', () => {
  it('shows the full navigation on desktop and Diary/Ledger on mobile', () => {
    expect(Object.entries(workspaceNavigationAvailability)
      .filter(([, availability]) => availability.desktop)
      .map(([key]) => key))
      .toEqual(['note', 'diary', 'ledger', 'board'])

    expect(Object.entries(workspaceNavigationAvailability)
      .filter(([, availability]) => availability.mobile)
      .map(([key]) => key))
      .toEqual(['diary', 'ledger'])
  })

  it('uses the existing inclusive 600px mobile boundary', () => {
    expect(workspaceMobileNavigationQuery).toBe('(max-width: 600px)')
    expect(isWorkspaceNavigationAvailable('note', 'mobile')).toBe(false)
    expect(isWorkspaceNavigationAvailable('board', 'mobile')).toBe(false)
    expect(isWorkspaceNavigationAvailable('diary', 'mobile')).toBe(true)
    expect(isWorkspaceNavigationAvailable('ledger', 'mobile')).toBe(true)
  })

  it('keeps workspace routes available regardless of navigation visibility', () => {
    expect(workspaceKindForPath('/vault/inbox/example')).toBe('vault')
    expect(workspaceKindForPath('/board')).toBe('board')
  })
})
