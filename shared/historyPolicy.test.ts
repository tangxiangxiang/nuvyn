import { describe, expect, it } from 'vitest'
import { isInboxDraftPath } from './historyPolicy'

describe('isInboxDraftPath', () => {
  it.each([
    'inbox',
    'inbox/',
    'inbox/foo',
    'inbox/foo.md',
    'inbox/a/b',
    'inbox/a/b.md',
  ])('matches Inbox path %s', (filePath) => {
    expect(isInboxDraftPath(filePath)).toBe(true)
  })

  it.each([
    'literature/foo',
    'literature/foo.md',
    'archive/foo',
    'archive/foo.md',
    'my-inbox/foo',
    'inbox-old/foo',
    '/inbox/foo',
  ])('does not match non-Inbox path %s', (filePath) => {
    expect(isInboxDraftPath(filePath)).toBe(false)
  })
})
