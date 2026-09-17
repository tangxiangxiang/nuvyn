import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { applyMigrations } from '../db'
import {
  preflightTagIdentityHealth,
  resetTagIdentityHealthForTesting,
  runTagIdentityMigrationForTesting,
} from '../tagIdentityMigration'

const SCALE_TEST_TIMEOUT_MS = 30_000

describe('Tags health scale evidence', { timeout: SCALE_TEST_TIMEOUT_MS }, () => {
  let db: Database.Database
  let root: string

  beforeEach(async () => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyMigrations(db)
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tags-health-scale-'))
  })

  afterEach(async () => {
    resetTagIdentityHealthForTesting(db)
    if (db.open) db.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('records live-path health preflight cost at the 10k-entry scale', async () => {
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(7, 'Java', 'java')
    const insertDocument = db.prepare(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES (?, ?, ?, '', 1, 1)
    `)
    const entryCount = 10000
    db.transaction(() => {
      for (let i = 0; i < entryCount; i++) {
        const id = `scale-${String(i).padStart(5, '0')}`
        insertDocument.run(id, id, id)
      }
    })()
    const writeBatchSize = 256
    for (let start = 0; start < entryCount; start += writeBatchSize) {
      const end = Math.min(start + writeBatchSize, entryCount)
      await Promise.all(Array.from({ length: end - start }, (_, offset) => {
        const i = start + offset
        const id = `scale-${String(i).padStart(5, '0')}`
        return fs.writeFile(path.join(root, `${id}.md`), '', 'utf8')
      }))
    }
    expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)

    const metadataOwnershipCount = (db.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count
    const heapBefore = process.memoryUsage().heapUsed
    const startedAt = performance.now()
    const health = await preflightTagIdentityHealth(db, root)
    const elapsedMs = Number((performance.now() - startedAt).toFixed(2))
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
    const evidence = {
      markdownEntries: entryCount,
      metadataOwnershipCount,
      elapsedMs,
      heapDeltaBytes,
    }
    console.info('[tag-management-health-perf]', JSON.stringify(evidence))

    expect(health.state).toBe('healthy')
    expect(metadataOwnershipCount).toBe(entryCount)
    expect(Number.isFinite(evidence.elapsedMs)).toBe(true)
    expect(Number.isFinite(evidence.heapDeltaBytes)).toBe(true)
  })
})
