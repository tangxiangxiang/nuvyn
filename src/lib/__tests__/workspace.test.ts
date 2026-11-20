import { describe, expect, it } from 'vitest'
import {
  isWorkspaceNavigationAvailable,
  workspaceCompactNavigationQuery,
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

  it('keeps every workspace available in desktop and compact navigation', () => {
    expect(Object.entries(workspaceNavigationAvailability)
      .filter(([, availability]) => availability.desktop)
      .map(([key]) => key))
      .toEqual(['note', 'diary', 'ledger', 'board'])

    expect(Object.entries(workspaceNavigationAvailability)
      .filter(([, availability]) => availability.compact)
      .map(([key]) => key))
      .toEqual(['note', 'diary', 'ledger', 'board'])
  })

  it('keeps phone and compact navigation boundaries explicit', () => {
    expect(workspaceMobileNavigationQuery).toBe('(max-width: 600px)')
    expect(workspaceCompactNavigationQuery).toBe('(max-width: 1199px)')
    expect(isWorkspaceNavigationAvailable('note', 'compact')).toBe(true)
    expect(isWorkspaceNavigationAvailable('board', 'compact')).toBe(true)
    expect(isWorkspaceNavigationAvailable('diary', 'compact')).toBe(true)
    expect(isWorkspaceNavigationAvailable('ledger', 'compact')).toBe(true)
  })

  it('keeps workspace routes available regardless of navigation visibility', () => {
    expect(workspaceKindForPath('/vault/inbox/example')).toBe('vault')
    expect(workspaceKindForPath('/board')).toBe('board')
  })
})
