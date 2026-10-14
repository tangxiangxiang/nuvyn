import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { applyMigrations, __setDbForTesting } from '../db.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import { AttachmentTrash, registerNoteImage, managedNoteImage, ATTACHMENT_TRASH_DIRECTORY } from '../attachments/trash.js'
import { readMarkdownResource } from '../markdownResources.js'
import { scanVaultAttachments } from '../attachments/adapters/vaultFiles.js'
import { recordAttachmentOperation } from '../attachments/audit.js'
import { ensureRepo } from '../history/repo.js'
import type { AttachmentCleanupPreview } from '../../shared/attachmentProtocol.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
let root: string
let db: Database.Database
let dbPath: string
let service: AttachmentTrash
let oldRoot: string
function preview(resourcePath: string): AttachmentCleanupPreview {
  return { resource: { kind: 'vault-file', path: resourcePath }, currentFinding: 'no-current-reference', riskLevel: 'review-required',
    referenceCount: 0, ownerCount: 0, stale: false, coverage: { currentNotes: 'complete', boardReferences: 'complete', historicalVersions: 'not-checked',
      unsavedDrafts: 'not-checked', protectedDiary: 'restricted', boardCheckpoints: 'not-checked', externalChanges: 'not-checked' },
    riskReasons: ['historical-versions-not-checked', 'draft-recovery-not-checked'], deletionAllowed: false, snapshotId: 'test-snapshot', checkedAt: Date.now() }
}
async function image(extension = '.png', bytes = PNG): Promise<string> {
  const resourcePath = `attachments/images/${randomUUID()}${extension}`
  await fs.writeFile(path.join(root, resourcePath), bytes)
  await registerNoteImage(db, root, resourcePath)
  return resourcePath
}
async function recycle(resourcePath: string) {
  const prepared = await service.preview(preview(resourcePath), 1, true)
  expect(prepared).toMatchObject({ quarantineAllowed: true, deletionAllowed: false })
  return service.quarantine(prepared.quarantineToken!, 1, async () => {})
}

describe('Note image recoverable trash', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-trash-test-'))
    await fs.mkdir(path.join(root, 'attachments/images'), { recursive: true })
    dbPath = path.join(root, 'test.sqlite')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    applyMigrations(db)
    __setDbForTesting(db)
    oldRoot = CONTENT_DIR
    setContentDir(root)
    service = new AttachmentTrash(db, root)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    __setDbForTesting(null)
    setContentDir(oldRoot)
    db.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it.each([['.png', PNG], ['.svg', SVG], ['.jpg', Buffer.from([255, 216, 255])], ['.jpeg', Buffer.from([255, 216, 255])],
    ['.gif', Buffer.from('GIF89a')], ['.webp', Buffer.from('RIFF0000WEBP')], ['.avif', Buffer.from('0000ftypavif')]])('recycles and restores %s with unchanged bytes and original generation', async (extension, bytes) => {
    const resourcePath = await image(extension, bytes)
    const stat = await fs.stat(path.join(root, resourcePath))
    const item = await recycle(resourcePath)
    await expect(fs.stat(path.join(root, resourcePath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(service.list().items).toHaveLength(1)
    expect((await scanVaultAttachments(root)).items).toHaveLength(0)
    expect(await service.read(resourcePath)).toEqual(bytes)
    const read = await readMarkdownResource('image', resourcePath)
    expect(read.kind).toBe('image')
    await service.restore(item.id)
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(bytes)
    expect((await fs.stat(path.join(root, resourcePath))).ino).toBe(stat.ino)
    expect(service.list().total).toBe(0)
    expect((await scanVaultAttachments(root)).items).toHaveLength(1)
    await service.restore(item.id) // Idempotent retry.
  })

  it('requires genuine upload provenance and rejects other resource classes', async () => {
    const raw = `attachments/images/${randomUUID()}.png`
    await fs.writeFile(path.join(root, raw), PNG)
    expect(await service.preview(preview(raw), 1, true)).toMatchObject({ quarantineAllowed: false, quarantineReason: 'identity-unverified' })
    for (const resource of [{ kind: 'asset', id: randomUUID() }, { kind: 'board-material', id: randomUUID() },
      { kind: 'vault-file', path: 'diary/image.png' }, { kind: 'vault-file', path: '../images/a.png' },
      { kind: 'vault-file', path: 'inbox/file.md' }, { kind: 'vault-file', path: 'inbox/image.png' }] as const) {
      expect(await service.preview({ ...preview(raw), resource }, 1, true)).toMatchObject({ quarantineAllowed: false, quarantineReason: 'unsupported' })
    }
    expect(managedNoteImage('attachments/images/../../x.png')).toBeNull()
  })

  it('fails closed for current use, stale/partial indexes, session/token changes and a newly added reference', async () => {
    const resourcePath = await image()
    const base = preview(resourcePath)
    for (const value of [{ ...base, stale: true }, { ...base, currentFinding: 'in-use' as const },
      { ...base, coverage: { ...base.coverage, currentNotes: 'partial' as const } }]) {
      expect((await service.preview(value, 1, true)).quarantineAllowed).toBe(false)
    }
    expect((await service.preview(base, 1, false)).quarantineAllowed).toBe(false)
    const prepared = await service.preview(base, 1, true)
    await expect(service.quarantine(prepared.quarantineToken!, 2, async () => {})).rejects.toThrow()
    await expect(service.quarantine(`${prepared.quarantineToken}changed`, 1, async () => {})).rejects.toThrow()
    await expect(service.quarantine(prepared.quarantineToken!, 1, async () => { throw new Error('new reference') })).rejects.toThrow('new reference')
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
    expect(service.list().total).toBe(0)
  })

  it('does not recycle a replaced generation, modified content, or a symbolic link', async () => {
    const resourcePath = await image()
    const prepared = await service.preview(preview(resourcePath), 1, true)
    await fs.unlink(path.join(root, resourcePath))
    await fs.writeFile(path.join(root, resourcePath), PNG)
    await expect(service.quarantine(prepared.quarantineToken!, 1, async () => {})).rejects.toThrow()
    const changed = await image()
    await fs.writeFile(path.join(root, changed), Buffer.from('changed'))
    expect((await service.preview(preview(changed), 1, true)).quarantineAllowed).toBe(false)
    await fs.unlink(path.join(root, resourcePath))
    await fs.symlink(path.join(root, changed), path.join(root, resourcePath))
    expect((await service.preview(preview(resourcePath), 1, true)).quarantineAllowed).toBe(false)
  })

  it('rejects restore conflicts even with identical bytes and rejects historical reads of replacements', async () => {
    const resourcePath = await image()
    const item = await recycle(resourcePath)
    await fs.writeFile(path.join(root, resourcePath), PNG)
    await expect(service.restore(item.id)).rejects.toThrow()
    await expect(readMarkdownResource('image', resourcePath)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, `${ATTACHMENT_TRASH_DIRECTORY}/${item.id}.png`))).toEqual(PNG)
    await fs.unlink(path.join(root, resourcePath))
    await service.restore(item.id)
  })

  it('keeps SVG safety validation on fallback reads', async () => {
    const resourcePath = await image('.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
    await recycle(resourcePath)
    await expect(readMarkdownResource('image', resourcePath)).rejects.toMatchObject({ code: 'resource-invalid-svg' })
  })

  it('keeps historical image reads working when the empty active image directory is removed', async () => {
    const resourcePath = await image()
    await recycle(resourcePath)
    await fs.rmdir(path.join(root, 'attachments/images'))
    expect((await readMarkdownResource('image', resourcePath)).content).toEqual(PNG)
  })

  it('preserves the original when linking fails and retries its journal after restart', async () => {
    const resourcePath = await image()
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(recycle(resourcePath)).rejects.toThrow('disk full')
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
    expect(service.list().items[0]?.state).toBe('recycling')
    link.mockRestore()
    await new AttachmentTrash(db, root).reconcile()
    expect(service.list().items[0]?.state).toBe('trashed')
    expect(await service.read(resourcePath)).toEqual(PNG)
  })

  it('uses FULL journal durability for a WAL NORMAL connection and restores its setting', async () => {
    db.pragma('synchronous = NORMAL')
    const resourcePath = await image()
    const link = fs.link.bind(fs)
    vi.spyOn(fs, 'link').mockImplementation(async (...args) => {
      expect(db.pragma('synchronous', { simple: true })).toBe(2)
      return link(...args)
    })
    const item = await recycle(resourcePath)
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
    await service.restore(item.id)
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
  })

  it('does not lose trash records when audit retention removes old events', async () => {
    const resourcePath = await image()
    await recycle(resourcePath)
    for (let index = 0; index < 510; index += 1) {
      recordAttachmentOperation(db, { operation: 'attachment-manager-upload', resourceType: 'vault-image', resourceId: randomUUID(), sourceWorkspace: 'local-file', targetWorkspace: 'note-library', result: 'success' })
    }
    expect(db.prepare('SELECT count(*) AS n FROM attachment_operation_audit').get()).toEqual({ n: 500 })
    expect(service.list().total).toBe(1)
    expect(await service.read(resourcePath)).toEqual(PNG)
  })

  it('expires confirmation tokens without moving files', async () => {
    const resourcePath = await image()
    const prepared = await service.preview(preview(resourcePath), 1, true)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await expect(service.quarantine(prepared.quarantineToken!, 1, async () => {})).rejects.toThrow()
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
  })

  it('reads an actual old Git Markdown version after recycling and excludes trash from history', async () => {
    const resourcePath = await image()
    await fs.mkdir(path.join(root, 'archive'))
    await fs.writeFile(path.join(root, 'archive/historical.md'), `# History\n\n![old](@/${resourcePath})`)
    await fs.writeFile(path.join(root, '.gitignore'), '') // Existing user policy must still gain trash exclusion.
    await ensureRepo(root)
    const git = promisify(execFile)
    await git('git', ['-C', root, 'add', 'archive/historical.md', resourcePath])
    await git('git', ['-C', root, '-c', 'user.name=Test Owner', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test: historical image fixture'])
    await fs.writeFile(path.join(root, 'archive/historical.md'), '# No current image')
    await recycle(resourcePath)
    const old = await git('git', ['-C', root, 'show', 'HEAD:archive/historical.md'])
    expect(old.stdout).toContain(`@/${resourcePath}`)
    const result = await readMarkdownResource('image', resourcePath)
    expect(result.content).toEqual(PNG)
    expect(await fs.readFile(path.join(root, '.git/info/exclude'), 'utf8')).toContain('/.nuvyn/attachment-trash/')
    const untracked = await git('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'])
    expect(untracked.stdout).not.toContain('attachment-trash')
  })

  it('preserves source and unknown incumbent when a trash destination conflicts', async () => {
    const resourcePath = await image()
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(recycle(resourcePath)).rejects.toThrow()
    link.mockRestore()
    const record = service.list().items[0]!
    const destination = path.join(root, ATTACHMENT_TRASH_DIRECTORY, `${record.id}.png`)
    await fs.writeFile(destination, PNG) // Same content, wrong generation.
    await service.reconcile()
    expect(service.list().items[0]?.state).toBe('recycling')
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
    expect(await fs.readFile(destination)).toEqual(PNG)
  })

  it('serializes duplicate recycle requests without losing or duplicating the binary', async () => {
    const resourcePath = await image()
    const prepared = await service.preview(preview(resourcePath), 1, true)
    const results = await Promise.allSettled([
      service.quarantine(prepared.quarantineToken!, 1, async () => {}),
      service.quarantine(prepared.quarantineToken!, 1, async () => {}),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(service.list().items).toHaveLength(1)
    expect(await service.read(resourcePath)).toEqual(PNG)
  })

  it('rejects hidden-directory symlinks and never follows them', async () => {
    const resourcePath = await image()
    await fs.symlink(path.join(root, 'attachments'), path.join(root, '.nuvyn'))
    expect((await service.preview(preview(resourcePath), 1, true)).quarantineAllowed).toBe(false)
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
  })

  it('paginates/searches trash separately from active storage and persists across reopening SQLite', async () => {
    const first = await image()
    await recycle(first)
    await recycle(await image('.svg', SVG))
    expect(service.list('', 0, 1)).toMatchObject({ total: 2, knownBytes: PNG.length + SVG.length })
    expect(service.list('', 1, 1).items).toHaveLength(1)
    expect(service.list(first).items).toHaveLength(1)
    db.close()
    db = new Database(dbPath)
    __setDbForTesting(db)
    service = new AttachmentTrash(db, root)
    expect(service.list().total).toBe(2)
    expect(await service.read(first)).toEqual(PNG)
    expect(db.prepare('SELECT count(*) AS n FROM attachment_operation_audit').get()).toEqual({ n: 2 })
  })

  it.each(['before-link', 'link', 'unlink'])('recovers after real SIGKILL at recycle %s boundary', async (boundary) => {
    const resourcePath = await image()
    await crash(boundary, 'quarantine', resourcePath)
    await service.reconcile()
    expect(service.list().items[0]?.state).toBe('trashed')
    expect(await service.read(resourcePath)).toEqual(PNG)
    await service.restore(service.list().items[0]!.id)
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
  })
  it.each(['before-link', 'link', 'unlink'])('recovers after real SIGKILL at restore %s boundary', async (boundary) => {
    const resourcePath = await image()
    const item = await recycle(resourcePath)
    await crash(boundary, 'restore', resourcePath, item.id)
    await service.reconcile()
    expect(service.list().total).toBe(0)
    expect(await fs.readFile(path.join(root, resourcePath))).toEqual(PNG)
  })
})

async function crash(boundary: string, operation: string, resourcePath: string, recordId = ''): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('server/__tests__/fixtures/attachment-trash-crash.ts'), root, dbPath, boundary, operation, resourcePath, recordId], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  expect(result.signal, stderr).toBe('SIGKILL')
}
