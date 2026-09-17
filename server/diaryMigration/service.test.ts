import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../db.js'
import { createDocumentMetadata } from '../documentMetadata.js'
import { encryptDiaryBody, decryptDiaryBody, readDiaryBody, type DiaryDocumentContext } from '../diaryAccess/body.js'
import { DiaryMigrationService } from './service.js'

const VAULT_ID = 'd8-4-test-vault'
const DOCUMENT_ID = 'd8-4-document'
const LOGICAL_PATH = 'diary/2026-08-31'
const PASSWORD_KEY = Buffer.alloc(32, 7)

function bodyOperation() {
  return {
    assertCurrent() {},
    isCurrent: () => true,
    encrypt: (raw: string, context: DiaryDocumentContext) =>
      encryptDiaryBody(raw, { vaultId: VAULT_ID, ...context }, PASSWORD_KEY),
    decrypt: (bytes: Buffer, context: DiaryDocumentContext) =>
      decryptDiaryBody(bytes, { vaultId: VAULT_ID, ...context }, PASSWORD_KEY),
    read: (absolutePath: string, context: DiaryDocumentContext) =>
      readDiaryBody(absolutePath, { vaultId: VAULT_ID, ...context }, PASSWORD_KEY),
  }
}

describe('D8.4 Diary migration service', () => {
  it('prepares a ciphertext-only candidate and verifies the platform finalize contract', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-d8-4-'))
    await fs.mkdir(path.join(root, 'diary'))
    const primary = path.join(root, 'diary', '2026-08-31.md')
    const plaintext = '# private diary\nnever durable in a migration ledger'
    await fs.writeFile(primary, plaintext, 'utf8')

    const db = new Database(':memory:')
    applyMigrations(db)
    createDocumentMetadata(db, {
      id: DOCUMENT_ID,
      path: LOGICAL_PATH,
      title: 'Old title',
      summary: 'private summary',
      tags: ['private'],
      mood: null,
      createdAt: 1,
      updatedAt: 1,
    })
    const service = new DiaryMigrationService({ db, rootDir: root, vaultId: () => VAULT_ID, now: () => 2 })

    const inventory = await service.scan()
    expect(inventory.state).toBe('NEEDS_UNLOCK')
    const item = service.status(inventory.runId, inventory.inventoryRevision).items.find((entry) => entry.canonicalPath === LOGICAL_PATH)
    expect(item).toMatchObject({ classification: 'LEGACY_PLAINTEXT', state: 'NEEDS_UNLOCK' })
    expect(item?.itemKey).toContain(`${VAULT_ID}\u0000${DOCUMENT_ID}`)

    await expect(service.start(inventory.runId, inventory.inventoryRevision, [{ itemKey: item!.itemKey, scope: 'MIGRATE_PRIMARY' }]))
      .rejects.toMatchObject({ code: 'diary-migration-locked', status: 423 })

    const migration = service.start(
      inventory.runId,
      inventory.inventoryRevision,
      [{ itemKey: item!.itemKey, scope: 'MIGRATE_PRIMARY' }],
      bodyOperation(),
    )
    if (process.platform === 'win32') {
      await expect(migration).rejects.toMatchObject({
        code: 'diary-migration-durability-pending',
        status: 409,
      })
      const pending = service.status(inventory.runId, inventory.inventoryRevision)
      expect(pending.items.find((entry) => entry.canonicalPath === LOGICAL_PATH)).toMatchObject({
        classification: 'UNSUPPORTED',
        state: 'DURABILITY_PENDING',
        migrationFinalizeCapability: 'USER_FINALIZE_REQUIRED',
      })
      // Windows Node cannot prove the parent-directory durability barrier;
      // the safe result is a pending migration with the plaintext untouched.
      expect(await fs.readFile(primary, 'utf8')).toBe(plaintext)
      db.close()
      await fs.rm(root, { recursive: true, force: true })
      return
    }
    const prepared = await migration
    expect(prepared.items.find((entry) => entry.canonicalPath === LOGICAL_PATH)).toMatchObject({
      classification: 'USER_FINALIZE_REQUIRED',
      state: 'USER_FINALIZE_REQUIRED',
      migrationFinalizeCapability: 'USER_FINALIZE_REQUIRED',
    })
    expect(await fs.readFile(primary, 'utf8')).toBe(plaintext)

    const row = db.prepare('SELECT candidate_name, ciphertext_fingerprint FROM diary_migration_items WHERE item_key = ?').get(item!.itemKey) as { candidate_name: string; ciphertext_fingerprint: string }
    const candidate = path.join(root, 'diary', row.candidate_name)
    const candidateBytes = await fs.readFile(candidate)
    expect(candidateBytes.toString('utf8').startsWith('NUVYN-DIARY-ENC-V1\n')).toBe(true)
    expect(candidateBytes.toString('utf8')).not.toContain(plaintext)
    expect(row.ciphertext_fingerprint).toMatch(/^[a-f0-9]{64}$/)

    const pending = await service.resume(inventory.runId, inventory.inventoryRevision, bodyOperation())
    expect(pending.items.find((entry) => entry.canonicalPath === LOGICAL_PATH)).toMatchObject({
      classification: 'USER_FINALIZE_REQUIRED',
      state: 'USER_FINALIZE_REQUIRED',
    })

    await fs.copyFile(candidate, primary)
    const published = await service.resume(inventory.runId, inventory.inventoryRevision, bodyOperation())
    expect(published.items.find((entry) => entry.canonicalPath === LOGICAL_PATH)).toMatchObject({
      classification: 'CLEANUP_PENDING',
      state: 'CLEANUP_PENDING',
    })

    const cleaned = await service.start(
      inventory.runId,
      inventory.inventoryRevision,
      [{ itemKey: item!.itemKey, scope: 'CLEAN_PRIVATE_SQLITE' }],
      bodyOperation(),
    )
    expect(cleaned.items.find((entry) => entry.canonicalPath === LOGICAL_PATH)).toMatchObject({
      state: 'COMPLETE',
      classification: 'CLEANUP_PENDING',
    })
    expect(db.prepare('SELECT title, summary FROM documents WHERE id = ?').get(DOCUMENT_ID)).toEqual({ title: '2026-08-31', summary: '' })
    expect(await fs.readFile(primary)).toEqual(candidateBytes)
    expect(await fs.stat(candidate).catch(() => null)).toBeNull()

    db.close()
    await fs.rm(root, { recursive: true, force: true })
  })
})
