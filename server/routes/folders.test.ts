import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyMigrations } from '../db'
import {
  getDocumentMetadata,
  saveDocumentMetadata,
} from '../documentMetadata'
import {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
  platformDirectoryMoveStrategy,
} from '../documentFileLifecycle'
import { recoverInterruptedOperations } from '../crashRecovery'
import app, { __setMetadataDbForTesting } from '../index'
import { __resetLinkIndexForTesting } from '../linkIndex'
import { setContentDir } from '../paths'
import { closeAuthTestContext, createAuthenticatedTestContext, withAuthCookie, type AuthenticatedTestContext } from '../__tests__/helpers/auth'

let vault: string
let originalContentDir: string
let db: Database.Database
let auth: AuthenticatedTestContext

beforeEach(async () => {
  originalContentDir = path.resolve(process.cwd(), 'src/content')
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-folder-route-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  auth = createAuthenticatedTestContext({ db })
  __setMetadataDbForTesting(db)
  setContentDir(vault)
  __resetLinkIndexForTesting()
  // Exercise the production capability matrix:
  // POSIX uses atomic-rename; Windows uses replayable-move.
  __setDirectoryMoveStrategyOverrideForTesting(null)
})

afterEach(async () => {
  __setCreateOnlyMoveHooksForTesting(null)
  __setDirectoryMoveStrategyOverrideForTesting(null)
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  setContentDir(originalContentDir)
  __resetLinkIndexForTesting()
  await fs.rm(vault, { recursive: true, force: true })
})

describe('folder route v4 coordinator', () => {
  it('finishes a real PATCH through the shared final verifier', async () => {
    await fs.mkdir(path.join(vault, 'proj'))
    await fs.writeFile(path.join(vault, 'proj', 'a.md'), '# a\n')
    saveDocumentMetadata(db, {
      id: 'route-a-id',
      path: 'proj/a',
      title: 'A',
      updatedAt: 1,
    })

    const response = await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/folders/proj', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPath: 'ren' }),
    })))

    expect(response.status).toBe(200)
    expect(await fs.readFile(path.join(vault, 'ren', 'a.md'), 'utf8')).toBe('# a\n')
    await expect(fs.stat(path.join(vault, 'proj'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('route-a-id')
    expect(getDocumentMetadata(db, 'proj/a')).toBeNull()
    expect((await fs.readdir(vault)).some(name => name.includes('.nuvyn-journal-'))).toBe(false)
  })
})

describe.runIf(platformDirectoryMoveStrategy === 'replayable-move')(
  'Windows replayable folder move coverage',
  () => {
    it('recovers a platform move interrupted after one entry', async () => {
      await fs.mkdir(path.join(vault, 'proj'))
      await fs.writeFile(path.join(vault, 'proj', 'a.md'), '# a\n')
      await fs.writeFile(path.join(vault, 'proj', 'b.md'), '# b\n')
      saveDocumentMetadata(db, {
        id: 'route-a-id',
        path: 'proj/a',
        title: 'A',
        updatedAt: 1,
      })
      saveDocumentMetadata(db, {
        id: 'route-b-id',
        path: 'proj/b',
        title: 'B',
        updatedAt: 1,
      })
      let interrupted = false
      __setCreateOnlyMoveHooksForTesting({
        afterReplayableMovedEntry: async () => {
          if (interrupted) return
          interrupted = true
          throw new Error('injected Windows replayable interruption')
        },
      })

      const response = await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/folders/proj', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPath: 'ren' }),
      })))

      expect(response.status).toBe(500)
      expect(interrupted).toBe(true)
      const journalName = (await fs.readdir(vault))
        .find(name => name.includes('.nuvyn-journal-'))
      expect(journalName).toBeDefined()
      const journal = JSON.parse(
        await fs.readFile(path.join(vault, journalName!), 'utf8'),
      ) as {
        phase: string
        strategy: string
        gateProof?: {
          markerName: string
          secret: string
        }
      }
      expect(journal).toMatchObject({
        phase: 'gate-created',
        strategy: 'replayable-move',
      })
      expect(journal.gateProof).toBeDefined()
      expect(await fs.readFile(
        path.join(vault, 'ren', journal.gateProof!.markerName),
        'utf8',
      )).toBe(journal.gateProof!.secret)
      expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
      await expect(fs.stat(path.join(vault, 'proj/a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(path.join(vault, 'proj/b.md'), 'utf8')).toBe('# b\n')

      __setCreateOnlyMoveHooksForTesting(null)
      const first = await recoverInterruptedOperations(vault, db)
      expect(first.actions).toContainEqual(expect.objectContaining({
        action: 'completed-rename',
      }))
      expect(await fs.readFile(path.join(vault, 'ren', 'a.md'), 'utf8')).toBe('# a\n')
      expect(await fs.readFile(path.join(vault, 'ren', 'b.md'), 'utf8')).toBe('# b\n')
      await expect(fs.stat(path.join(vault, 'proj'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('route-a-id')
      expect(getDocumentMetadata(db, 'ren/b')?.id).toBe('route-b-id')
      await expect(fs.stat(
        path.join(vault, 'ren', journal.gateProof!.markerName),
      )).rejects.toMatchObject({ code: 'ENOENT' })

      const second = await recoverInterruptedOperations(vault, db)
      expect(second.actions).toEqual([])
      expect((await fs.readdir(vault)).some(name => name.includes('.nuvyn-journal-'))).toBe(false)
    })
  },
)
