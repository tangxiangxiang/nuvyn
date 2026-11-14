import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../index'
import { applyMigrations } from '../db'
import { CONTENT_DIR, setContentDir } from '../paths'
import { __resetLinkIndexForTesting } from '../linkIndex'
import { __setAtomicWriteCrashHooksForTesting, __setAtomicWriteTestHooksForTesting, sha256Hex } from '../atomicTextWrite'
import {
  closeAuthTestContext, createAuthenticatedTestContext, jsonRequest,
  unlockDiaryAccessForTesting, withAuthCookie, withDiaryCapability, type AuthenticatedTestContext,
} from './helpers/auth'

const base = '/api/diary/plans'
const date = '2032-02-29'
const otherDate = '2032-03-01'
const originalVault = CONTENT_DIR
let db: Database.Database
let auth: AuthenticatedTestContext
let capability: string
let vault: string

function request(method: string, url: string, body?: unknown, unlocked = true, signal?: AbortSignal) {
  const req = jsonRequest(url, {
    method,
    body: body ?? (url === `${base}/migrate` ? { backupConfirmed: true } : undefined),
    origin: auth.runtime.config.publicOrigin,
  })
  const authenticated = unlocked ? withDiaryCapability(auth, req, capability) : withAuthCookie(auth, req)
  return app.fetch(signal ? new Request(authenticated, { signal }) : authenticated)
}

async function seed(day: string, title: string, completedAt: number | null = null) {
  const id = randomUUID()
  const ownerId = auth.session.userId
  const payload = await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, (operation) =>
    operation.plan!.encrypt({ title, plannedTime: null }, { ownerId, id, date: day }))
  db.prepare(`
    INSERT INTO diary_plan_items VALUES (?, ?, ?, ?, ?, 1, 2, 3)
  `).run(ownerId, id, day, payload, completedAt)
  return id
}

async function raw(day: string) {
  const response = await request('GET', `/api/posts/diary/${day}`)
  expect(response.status).toBe(200)
  return (await response.json()).raw as string
}

function checkpoint(day: string) {
  return db.prepare('SELECT * FROM diary_plan_markdown_migration WHERE date = ?').get(day)
}

describe('Diary Plan Markdown migration', () => {
  beforeEach(async () => {
    db = new Database(':memory:')
    auth = createAuthenticatedTestContext({ db })
    capability = await unlockDiaryAccessForTesting(auth)
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-plan-migration-'))
    setContentDir(vault)
    __resetLinkIndexForTesting()
  })

  afterEach(async () => {
    __setAtomicWriteTestHooksForTesting(null)
    __setAtomicWriteCrashHooksForTesting(null)
    setContentDir(originalVault)
    __resetLinkIndexForTesting()
    closeAuthTestContext(auth)
    db.close()
    await fs.rm(vault, { recursive: true, force: true })
  })

  it('upgrades version 40 without modifying encrypted plan rows', () => {
    const upgrade = new Database(':memory:')
    try {
      applyMigrations(upgrade, 40)
      upgrade.prepare(`
        INSERT INTO users (id, username, username_normalized, password_hash, created_at, updated_at)
        VALUES (1, 'legacy', 'legacy', 'test', 1, 1)
      `).run()
      upgrade.prepare('INSERT INTO diary_plan_items VALUES (1, ?, ?, ?, 3, 1, 2, 4)')
        .run('old-id', date, Buffer.from('ciphertext fixture'))
      const original = upgrade.prepare('SELECT * FROM diary_plan_items').all()
      applyMigrations(upgrade)
      applyMigrations(upgrade)
      expect(upgrade.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 42 })
      expect(upgrade.prepare('SELECT * FROM diary_plan_items').all()).toEqual(original)
      expect(upgrade.prepare('SELECT * FROM diary_plan_markdown_migration').all()).toEqual([])
    } finally {
      upgrade.close()
    }
  })

  it('handles an empty source, requires unlock and explicitly rejects stale writers', async () => {
    expect((await request('POST', `${base}/migrate`, undefined, false)).status).toBe(423)
    expect((await request('GET', `${base}/calendar?month=2032-02`, undefined, false)).status).toBe(423)
    expect(await (await request('POST', `${base}/migrate`)).json()).toEqual({ migrated: 0, failures: [], next: null })
    for (const [method, url] of [['POST', base], ['PATCH', `${base}/old`], ['DELETE', `${base}/old`]]) {
      expect((await request(method!, url!)).status).toBe(410)
    }
  })

  it('reads status without changing the vault and requires explicit confirmation', async () => {
    await seed(date, 'Private task')
    expect((await request('GET', `${base}/migration-status`, undefined, false)).status).toBe(423)
    expect(await (await request('GET', `${base}/migration-status`)).json()).toEqual({
      hasLegacyPlans: true, completed: 0, pending: 1, failures: [], hasConflicts: false,
    })
    expect((await request('POST', `${base}/migrate`, {})).status).toBe(400)
    expect(checkpoint(date)).toBeUndefined()
    expect(await fs.readdir(vault)).toEqual([])
  })

  it('merges encrypted items by date, preserves Diary bytes and deduplicates concurrent migration', async () => {
    expect((await request('POST', '/api/diary/dates', { date, timeZone: 'UTC' })).status).toBe(201)
    const initial = await raw(date)
    const custom = '# Private diary\n\nFree-form content  \n'
    expect((await request('PUT', `/api/posts/diary/${date}`, { raw: custom, baseRaw: initial })).status).toBe(200)
    const first = await seed(date, 'Confidential duplicate')
    const second = await seed(date, 'Confidential duplicate', 5)
    await seed(otherDate, 'Another day')
    const source = db.prepare('SELECT * FROM diary_plan_items ORDER BY id').all()
    const results = await Promise.all([request('POST', `${base}/migrate`), request('POST', `${base}/migrate`)])
    expect(results.map((result) => result.status)).toEqual([200, 200])
    expect((await Promise.all(results.map((result) => result.json()))).reduce((sum, result) => sum + result.migrated, 0)).toBe(2)
    expect(await raw(date)).toBe(`${custom}\n\n## 计划\n\n- [ ] Confidential duplicate\n- [x] Confidential duplicate\n`)
    expect(await raw(otherDate)).toContain('- [ ] Another day')
    expect(checkpoint(date)).toMatchObject({
      document_id: expect.any(String), completed_at: expect.any(Number),
      source_versions: JSON.stringify([first, second].sort().map((id) => [id, 3])),
    })
    expect(db.prepare('SELECT * FROM diary_plan_items ORDER BY id').all()).toEqual(source)
    const physical = await fs.readFile(path.join(vault, 'diary', `${date}.md`), 'utf8')
    expect(checkpoint(date)).toMatchObject({ target_hash: sha256Hex(physical) })
    expect(physical).not.toMatch(/Confidential duplicate|Free-form content/)
    expect(JSON.stringify(checkpoint(date))).not.toContain('Confidential duplicate')
    expect(auth.logs.join(' ')).not.toContain('Confidential duplicate')
    expect(await (await request('GET', `${base}/calendar?month=2032-02`)).json()).toMatchObject({
      days: [{ date, total: 2, completed: 1 }, { date: otherDate, total: 1, completed: 0 }],
    })
    const later = `${custom}\nUser edit after migration\n`
    expect((await request('PUT', `/api/posts/diary/${date}`, { raw: later, baseRaw: await raw(date) })).status).toBe(200)
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({ migrated: 0 })
    expect(await raw(date)).toBe(later)
  })

  it('isolates corrupt dates and resumes after the file lands before SQLite confirmation', async () => {
    const damaged = await seed(date, 'Damaged task')
    await seed(otherDate, 'Published before interruption')
    const { encrypted_fields: original } = db.prepare('SELECT encrypted_fields FROM diary_plan_items WHERE id = ?')
      .get(damaged) as { encrypted_fields: Buffer }
    db.prepare('UPDATE diary_plan_items SET encrypted_fields = ? WHERE id = ?').run(Buffer.from('corrupt'), damaged)
    __setAtomicWriteTestHooksForTesting({
      afterCreateCommitBeforeCleanup() { throw new Error('Interrupted after publish') },
    })
    const first = await (await request('POST', `${base}/migrate`)).json()
    expect(first.failures).toEqual([
      { date, code: 'diary-plan-payload-invalid' },
      { date: otherDate, code: 'diary-plan-migration-unavailable' },
    ])
    expect(await (await request('GET', `${base}/migration-status`)).json()).toMatchObject({
      completed: 0, pending: 2, failures: first.failures, hasConflicts: true,
    })
    expect(checkpoint(date)).toBeUndefined()
    expect(checkpoint(otherDate)).toMatchObject({ completed_at: null })
    const written = await raw(otherDate)
    __setAtomicWriteTestHooksForTesting(null)
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({ migrated: 1 })
    expect(await raw(otherDate)).toBe(written)
    db.prepare('UPDATE diary_plan_items SET encrypted_fields = ? WHERE id = ?').run(original, damaged)
    expect(await (await request('POST', `${base}/migrate`)).json()).toEqual({ migrated: 1, failures: [], next: null })
    expect(await raw(date)).toContain('Damaged task')
    expect(await (await request('GET', `${base}/migration-status`)).json()).toMatchObject({
      completed: 2, pending: 0, failures: [], hasConflicts: false,
    })
  })

  it('fails closed when a prepared checkpoint no longer matches the document or the source version', async () => {
    const id = await seed(date, 'Private task')
    __setAtomicWriteTestHooksForTesting({
      afterCreateCommitBeforeCleanup() { throw new Error('Interrupted after publish') },
    })
    await request('POST', `${base}/migrate`)
    __setAtomicWriteTestHooksForTesting(null)
    const baseRaw = await raw(date)
    const edited = '# User removed the task'
    expect((await request('PUT', `/api/posts/diary/${date}`, { raw: edited, baseRaw })).status).toBe(200)
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({
      failures: [{ date, code: 'diary-plan-migration-conflict' }],
    })
    db.prepare('UPDATE diary_plan_items SET version = version + 1 WHERE id = ?').run(id)
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({
      failures: [{ date, code: 'diary-plan-migration-conflict' }],
    })
    expect(await raw(date)).toBe(edited)
    expect(checkpoint(date)).toMatchObject({ completed_at: null })
  })

  it('leaves the base intact when interrupted before publishing and safely resumes', async () => {
    await request('POST', '/api/diary/dates', { date, timeZone: 'UTC' })
    const original = await raw(date)
    await seed(date, 'Pending after interruption')
    __setAtomicWriteTestHooksForTesting({
      afterTemporaryCloseBeforeIdentity() { throw new Error('Interrupted during staging') },
    })
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({
      migrated: 0,
      failures: [{ date, code: 'diary-plan-migration-unavailable' }],
    })
    expect(await raw(date)).toBe(original)
    __setAtomicWriteTestHooksForTesting(null)
    expect(await (await request('POST', `${base}/migrate`)).json()).toEqual({ migrated: 1, failures: [], next: null })
    expect(await raw(date)).toContain('- [ ] Pending after interruption')
  })

  it('preserves an external edit that lands immediately before replacement', async () => {
    await request('POST', '/api/diary/dates', { date, timeZone: 'UTC' })
    await seed(date, 'Unmigrated task')
    const logicalPath = `diary/${date}`
    const { id: documentId } = db.prepare('SELECT id FROM documents WHERE path = ?').get(logicalPath) as { id: string }
    const edited = '# A concurrent encrypted edit\n'
    const bytes = await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, (operation) =>
      operation.encrypt(edited, { logicalPath, documentId }))
    __setAtomicWriteCrashHooksForTesting({
      async afterJournalWrite() {
        await fs.writeFile(path.join(vault, `${logicalPath}.md`), bytes!)
      },
    })
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({
      failures: [{ date, code: 'diary-plan-migration-conflict' }],
    })
    expect(await raw(date)).toBe(edited)
    expect(checkpoint(date)).toMatchObject({ completed_at: null })
  })

  it.each(['lock', 'abort'] as const)('leaves the prepared base intact on %s before publication', async (action) => {
    await request('POST', '/api/diary/dates', { date, timeZone: 'UTC' })
    await seed(date, 'Resumable task')
    const file = path.join(vault, 'diary', `${date}.md`)
    const original = await fs.readFile(file, 'utf8')
    const controller = new AbortController()
    let lock: Promise<unknown> | undefined
    __setAtomicWriteCrashHooksForTesting({
      afterJournalWrite() {
        if (action === 'lock') lock = auth.runtime.diaryAccess.lock(auth.session.id)
        else controller.abort()
      },
    })
    const response = await request('POST', `${base}/migrate`, undefined, true, controller.signal)
    await lock
    expect(response.status).toBe(action === 'lock' ? 423 : 200)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(checkpoint(date)).toMatchObject({ completed_at: null, base_hash: sha256Hex(original) })
    __setAtomicWriteCrashHooksForTesting(null)
    if (action === 'lock') {
      capability = (await auth.runtime.diaryAccess.unlock(auth.session.id, 'diary-access-test-password')).capability
    }
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({ migrated: 1 })
    expect((await raw(date)).match(/Resumable task/g)).toHaveLength(1)
  })

  it('recovers from a SQLite confirmation failure without publishing a second generation', async () => {
    await seed(date, 'Already published')
    db.exec(`
      CREATE TRIGGER reject_confirmation BEFORE UPDATE OF completed_at ON diary_plan_markdown_migration
      BEGIN SELECT RAISE(ABORT, 'Injected SQLite confirmation failure'); END
    `)
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({
      failures: [{ date, code: 'diary-plan-migration-unavailable' }],
    })
    const file = path.join(vault, 'diary', `${date}.md`)
    const published = await fs.readFile(file, 'utf8')
    expect(checkpoint(date)).toMatchObject({ completed_at: null, target_hash: sha256Hex(published) })
    db.exec('DROP TRIGGER reject_confirmation')
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({ migrated: 1 })
    expect(await fs.readFile(file, 'utf8')).toBe(published)
    expect((await raw(date)).match(/Already published/g)).toHaveLength(1)
  })

  it('leaves a legacy plaintext primary untouched for the existing encryption workflow', async () => {
    await request('POST', '/api/diary/dates', { date, timeZone: 'UTC' })
    await seed(date, 'Private legacy item')
    const absolute = path.join(vault, 'diary', `${date}.md`)
    const legacy = '# Legacy plaintext diary\n'
    await fs.writeFile(absolute, legacy)
    expect(await (await request('POST', `${base}/migrate`)).json()).toMatchObject({
      failures: [{ date, code: 'diary-plan-document-needs-encryption' }],
    })
    expect(await fs.readFile(absolute, 'utf8')).toBe(legacy)
    expect(await fs.readdir(path.dirname(absolute))).toEqual([`${date}.md`])
    expect(checkpoint(date)).toBeUndefined()
  })
})
