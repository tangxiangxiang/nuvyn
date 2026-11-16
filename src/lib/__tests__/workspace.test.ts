import { describe, expect, it } from 'vitest'
import {
  isWorkspaceNavigationAvailable,
  workspaceDisplayNames,
  workspaceMobileNavigationQuery,
  workspaceNavigationAvailability,
  workspaceKindForPath,
} from '../workspace'

describe('workspace navigation availability', () => {
  it('uses the shared Chinese display names for all workspaces', () => {
    expect(workspaceDisplayNames).toEqual({
      note: '笔记',
      diary: '日程',
      ledger: '账本',
      board: '白板',
    })
  })

  it('shows the full navigation on both desktop and mobile', () => {
    expect(Object.entries(workspaceNavigationAvailability)
      .filter(([, availability]) => availability.desktop)
      .map(([key]) => key))
      .toEqual(['note', 'diary', 'ledger', 'board'])

    expect(Object.entries(workspaceNavigationAvailability)
      .filter(([, availability]) => availability.mobile)
      .map(([key]) => key))
      .toEqual(['note', 'diary', 'ledger', 'board'])
  })

  it('uses the existing inclusive 600px mobile boundary', () => {
    expect(workspaceMobileNavigationQuery).toBe('(max-width: 600px)')
    expect(isWorkspaceNavigationAvailable('note', 'mobile')).toBe(true)
    expect(isWorkspaceNavigationAvailable('board', 'mobile')).toBe(true)
    expect(isWorkspaceNavigationAvailable('diary', 'mobile')).toBe(true)
    expect(isWorkspaceNavigationAvailable('ledger', 'mobile')).toBe(true)
  })

  it('keeps workspace routes available regardless of navigation visibility', () => {
    expect(workspaceKindForPath('/vault/inbox/example')).toBe('vault')
    expect(workspaceKindForPath('/board')).toBe('board')
  })
})
