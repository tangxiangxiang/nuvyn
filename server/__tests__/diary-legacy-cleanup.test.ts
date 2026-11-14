import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db'
import { createDocumentMetadata } from '../documentMetadata'
import { cleanupLegacyDiary } from '../diaryLegacyCleanup'

let db: Database.Database
let root: string
beforeEach(async () => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyMigrations(db)
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-retirement-'))
  await fs.mkdir(path.join(root, 'diary'))
})
afterEach(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }) })
it('removes only verified managed date files and is idempotent', async () => {
  for (const file of ['diary/2026-11-15', 'diary/notes', 'diary/2026-02-30', 'inbox/2026-11-15']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, `${file}.md`), 'fixture')
    createDocumentMetadata(db, { path: file, title: 'Fixture' })
  }
  await fs.writeFile(path.join(root, 'diary/2026-11-16.md'), 'unmanaged physical file')
  expect(await cleanupLegacyDiary(db, root)).toBe(1)
  expect(await cleanupLegacyDiary(db, root)).toBe(0)
  for (const file of ['diary/notes.md', 'diary/2026-02-30.md', 'inbox/2026-11-15.md', 'diary/2026-11-16.md']) {
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBeTruthy()
  }
})
it('does not follow file or directory symlinks', async () => {
  await fs.writeFile(path.join(root, 'note.md'), 'preserved')
  await fs.symlink(path.join(root, 'note.md'), path.join(root, 'diary/2026-11-15.md'))
  createDocumentMetadata(db, { path: 'diary/2026-11-15', title: 'Fixture' })
  expect(await cleanupLegacyDiary(db, root)).toBe(0)
  expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe('preserved')
  await fs.rename(path.join(root, 'diary'), path.join(root, 'other'))
  await fs.symlink(path.join(root, 'other'), path.join(root, 'diary'))
  expect(await cleanupLegacyDiary(db, root)).toBe(0)
})
