import { describe, expect, it } from 'vitest'
import {
  blockedMessage,
  canCreateFileChild,
  canModify,
  canMove,
  isInArchive,
  isProtectedRoot,
  readonlyReason,
} from '../archiveProtocol'

const t = (key: string) => key

describe('Archive Soft-Policy protocol', () => {
  it('keeps the existing top-level system roots protected', () => {
    for (const root of ['inbox', 'literature', 'archive']) {
      expect(isProtectedRoot(root)).toBe(true)
      expect(canModify(root)).toBe(false)
      expect(canMove(root)).toBe(false)
      expect(blockedMessage(root, 'rename', t)).not.toBeNull()
      expect(blockedMessage(root, 'delete', t)).not.toBeNull()
      expect(blockedMessage(root, 'move', t)).not.toBeNull()
      expect(canCreateFileChild(root)).toBe(true)
      expect(blockedMessage(root, 'create-file', t)).toBeNull()
      expect(blockedMessage(root, 'create-folder', t)).toBeNull()
    }
  })

  it('protects the Diary root without protecting its descendants', () => {
    expect(isProtectedRoot('diary')).toBe(true)
    expect(readonlyReason('diary')).toBe('root')
    expect(canModify('diary')).toBe(false)
    expect(canMove('diary')).toBe(false)
    expect(blockedMessage('diary', 'rename', t)).not.toBeNull()
    expect(blockedMessage('diary', 'delete', t)).not.toBeNull()
    expect(blockedMessage('diary', 'move', t)).not.toBeNull()

    expect(isProtectedRoot('diary/2026-08-24')).toBe(false)
    expect(readonlyReason('diary/2026-08-24')).toBeNull()
    expect(canModify('diary/2026-08-24')).toBe(true)
    expect(canMove('diary/2026-08-24')).toBe(true)
  })

  it('does not impose an archive-specific root policy on descendants', () => {
    expect(isInArchive('archive/foo.md')).toBe(true)
    expect(isInArchive('archive/folder/foo.md')).toBe(true)
    expect(isProtectedRoot('archive/foo.md')).toBe(false)
    expect(readonlyReason('archive')).toBe('root')
    expect(readonlyReason('archive/foo.md')).toBeNull()

    expect(canModify('archive/foo.md')).toBe(true)
    expect(canModify('archive/folder/foo.md')).toBe(true)
    expect(canMove('archive/foo.md')).toBe(true)
    // canMove() answers only whether the root policy blocks this path. The
    // current entity capability is applied by the FileTree UI: files can be
    // dragged, while folders do not support general re-parenting.
    expect(canMove('archive/folder')).toBe(true)
    expect(canCreateFileChild('archive')).toBe(true)
    expect(canCreateFileChild('archive/folder')).toBe(true)

    for (const [path, op] of [
      ['archive/foo.md', 'rename'],
      ['archive/foo.md', 'delete'],
      ['archive/foo.md', 'move'],
      ['archive/folder', 'create-file'],
    ] as const) {
      expect(blockedMessage(path, op, t)).toBeNull()
    }
  })
})
