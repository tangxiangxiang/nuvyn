import Database from 'better-sqlite3'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../db.js'
import { isSafeVaultImageIdentity, recordAttachmentOperation, listAttachmentOperations } from './audit.js'

const RESOURCE_ID = '550e8400-e29b-41d4-a716-446655440000'
const SOURCE_PATH = 'inbox/assets/architecture.svg'

describe('Attachment operation audit', () => {
  const db = new Database(':memory:')
  applyMigrations(db)

  afterAll(() => db.close())
  afterEach(() => db.exec('DELETE FROM attachment_operation_audit'))

  it('accepts safe Markdown image paths without admitting protected or non-canonical paths', () => {
    expect(isSafeVaultImageIdentity(SOURCE_PATH)).toBe(true)
    expect(isSafeVaultImageIdentity('diary/2026-10-14/private.png')).toBe(false)
    expect(isSafeVaultImageIdentity('inbox/../private.png')).toBe(false)
    expect(isSafeVaultImageIdentity('inbox/.private.png')).toBe(false)
    expect(isSafeVaultImageIdentity('/Volumes/vault/inbox/private.png')).toBe(false)
  })

  it('retains a bounded recent audit trail without storing payloads or absolute paths', () => {
    for (let index = 0; index < 503; index += 1) {
      recordAttachmentOperation(db, {
        operation: 'board-import-from-vault-image',
        resourceType: 'board-asset',
        resourceId: RESOURCE_ID,
        sourceWorkspace: 'vault-image',
        sourceResourceId: SOURCE_PATH,
        targetWorkspace: 'board',
        targetWorkspaceId: RESOURCE_ID,
        result: 'success',
        occurredAt: index + 1,
      })
    }

    const entries = listAttachmentOperations(db, 1000)
    expect(entries).toHaveLength(100)
    expect(entries[0]).toMatchObject({
      operation: 'board-import-from-vault-image',
      resourceId: RESOURCE_ID,
      sourceResourceId: SOURCE_PATH,
      targetWorkspaceId: RESOURCE_ID,
      result: 'success',
      occurredAt: 503,
    })
    const count = (db.prepare('SELECT COUNT(*) AS count FROM attachment_operation_audit').get() as { count: number }).count
    expect(count).toBe(500)

    recordAttachmentOperation(db, {
      operation: 'board-import-from-vault-image',
      resourceType: 'board-asset',
      resourceId: RESOURCE_ID,
      sourceWorkspace: 'vault-image',
      sourceResourceId: '/Volumes/vault/diary/private.svg',
      targetWorkspace: 'board',
      targetWorkspaceId: RESOURCE_ID,
      result: 'success',
    })
    const rows = listAttachmentOperations(db, 100)
    expect(rows).toHaveLength(100)
    expect(JSON.stringify(rows)).not.toContain('/Volumes')
    expect(JSON.stringify(rows)).not.toContain('private')
  })
})
