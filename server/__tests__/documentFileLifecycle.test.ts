import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { renameDocumentWithMetadata } from '../documentFileLifecycle'

describe('renameDocumentWithMetadata', () => {
  it('preserves metadata and rollback failures in an AggregateError', async () => {
    const metadataError = new Error('metadata transaction failed')
    const rollbackError = new Error('filesystem rollback failed')
    const renameFile = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError)
    const db = new Database(':memory:')
    try {
      const error = await renameDocumentWithMetadata({
        db,
        fromPath: 'inbox/a',
        toPath: 'inbox/b',
        fromAbs: '/vault/inbox/a.md',
        toAbs: '/vault/inbox/b.md',
        renameFile,
        moveMetadata: () => { throw metadataError },
      }).catch((caught) => caught)
      expect(error).toBeInstanceOf(AggregateError)
      expect(error.message).toMatch(/rollback also failed/)
      expect(error.errors).toEqual([metadataError, rollbackError])
      expect(renameFile).toHaveBeenNthCalledWith(2, '/vault/inbox/b.md', '/vault/inbox/a.md')
    } finally {
      db.close()
    }
  })

  it('rethrows the original metadata error when filesystem rollback succeeds', async () => {
    const metadataError = new Error('metadata transaction failed')
    const renameFile = vi.fn().mockResolvedValue(undefined)
    const db = new Database(':memory:')
    try {
      await expect(renameDocumentWithMetadata({
        db,
        fromPath: 'a', toPath: 'b', fromAbs: '/a.md', toAbs: '/b.md',
        renameFile,
        moveMetadata: () => { throw metadataError },
      })).rejects.toBe(metadataError)
      expect(renameFile).toHaveBeenCalledTimes(2)
    } finally {
      db.close()
    }
  })
})
