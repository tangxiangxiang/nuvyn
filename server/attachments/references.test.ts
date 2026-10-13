import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../db.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import { AttachmentReferenceIndex } from './references.js'

const originalContentDir = CONTENT_DIR
const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const boardA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const boardB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
let root = ''
let db: Database.Database

function addAsset(id = assetId): void {
  db.prepare(`INSERT INTO assets (id, mime_type, byte_size, sha256, storage_key, created_at)
    VALUES (?, 'image/png', 3, ?, ?, 1)`).run(id, 'a'.repeat(64), id)
}

function addBoard(id: string, title: string): void {
  db.prepare('INSERT INTO boards (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(id, title)
}

function addBoardAssetReference(id: string, ownerId: string, purpose: 'scene' | 'thumbnail'): void {
  db.prepare(`INSERT INTO asset_references (asset_id, owner_type, owner_id, purpose, created_at)
    VALUES (?, 'board', ?, ?, 1)`).run(id, ownerId, purpose)
}

async function writeNote(notePath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...notePath.split('/')) + '.md'
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-attachment-references-'))
  await fs.mkdir(path.join(root, 'inbox'), { recursive: true })
  setContentDir(root)
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(async () => {
  if (db.open) db.close()
  setContentDir(originalContentDir)
  await fs.rm(root, { recursive: true, force: true })
})

describe('Attachment reference index', () => {
  it('traces Markdown images through nested includes without treating code or remote images as local references', async () => {
    await fs.mkdir(path.join(root, 'inbox', 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'diagram.png'), Buffer.from([1, 2, 3]))
    await writeNote('inbox/shared', [
      '---',
      'title: Shared diagram source',
      '---',
      '![Diagram](@/inbox/assets/diagram.png)',
      '```md',
      '![Ignored](./assets/diagram.png)',
      '```',
      '`![Ignored](./assets/diagram.png)`',
      '![Remote](https://example.test/diagram.png)',
    ].join('\n'))
    await writeNote('inbox/outer', '<!--@include: ./shared.md-->')
    await writeNote('inbox/root', [
      '# Root note',
      '<!--@include: ./outer.md-->',
    ].join('\n'))

    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const result = await index.query({ kind: 'vault-file', path: 'inbox/assets/diagram.png' })

    expect(result.currentFinding).toBe('in-use')
    expect(result.coverage.currentNotes).toBe('complete')
    expect(result.referenceCount).toBe(3)
    expect(result.ownerCount).toBe(3)
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        owner: expect.objectContaining({ id: 'inbox/shared', title: 'Shared diagram source' }),
        kind: 'note-image',
        relation: 'direct',
        sourcePath: 'inbox/shared',
        line: 4,
      }),
      expect.objectContaining({
        owner: expect.objectContaining({ id: 'inbox/outer' }),
        relation: 'indirect',
        via: [expect.objectContaining({ id: 'inbox/shared' })],
      }),
      expect.objectContaining({
        owner: expect.objectContaining({ id: 'inbox/root' }),
        relation: 'indirect',
        via: [
          expect.objectContaining({ id: 'inbox/outer' }),
          expect.objectContaining({ id: 'inbox/shared' }),
        ],
      }),
    ]))
  })

  it('traces SVG Note images as ordinary Vault image attachments', async () => {
    const svgPath = 'attachments/images/550e8400-e29b-41d4-a716-446655440000.svg'
    await fs.mkdir(path.join(root, 'attachments', 'images'), { recursive: true })
    await fs.writeFile(path.join(root, ...svgPath.split('/')), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeNote('inbox/svg-reference', `![Architecture](@/${svgPath})`)

    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const result = await index.query({ kind: 'vault-file', path: svgPath })

    expect(result.currentFinding).toBe('in-use')
    expect(result.referenceCount).toBe(1)
    expect(result.references).toEqual([expect.objectContaining({
      owner: expect.objectContaining({ kind: 'note', id: 'inbox/svg-reference' }),
      kind: 'note-image',
      relation: 'direct',
      target: { kind: 'vault-file', id: svgPath },
    })])
  })

  it('indexes PNG and SVG images inside Flex with accurate direct and Include source lines', async () => {
    const pngPath = 'attachments/images/flex-a.png'
    const svgPath = 'attachments/images/flex-b.svg'
    await fs.mkdir(path.join(root, 'attachments', 'images'), { recursive: true })
    await fs.writeFile(path.join(root, ...pngPath.split('/')), Buffer.from([1, 2, 3]))
    await fs.writeFile(path.join(root, ...svgPath.split('/')), '<svg/>')
    await writeNote('inbox/gallery', [
      '::: flex',
      '',
      `![PNG](@/${pngPath})`,
      '',
      `![SVG](@/${svgPath})`,
      '',
      ':::',
    ].join('\n'))
    await writeNote('inbox/gallery-consumer', '<!--@include: ./gallery.md-->')

    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const [png, svg] = await Promise.all([
      index.query({ kind: 'vault-file', path: pngPath }),
      index.query({ kind: 'vault-file', path: svgPath }),
    ])

    expect(png.references).toHaveLength(2)
    expect(svg.references).toHaveLength(2)
    expect(png.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: expect.objectContaining({ id: 'inbox/gallery' }), relation: 'direct', line: 3 }),
      expect.objectContaining({ owner: expect.objectContaining({ id: 'inbox/gallery-consumer' }), relation: 'indirect', via: [expect.objectContaining({ id: 'inbox/gallery' })] }),
    ]))
    expect(svg.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: expect.objectContaining({ id: 'inbox/gallery' }), relation: 'direct', line: 5 }),
      expect.objectContaining({ owner: expect.objectContaining({ id: 'inbox/gallery-consumer' }), relation: 'indirect', via: [expect.objectContaining({ id: 'inbox/gallery' })] }),
    ]))
  })

  it('records supported snippet dependencies and marks unresolved references as incomplete', async () => {
    await fs.mkdir(path.join(root, 'inbox', 'examples'), { recursive: true })
    await fs.writeFile(path.join(root, 'inbox', 'examples', 'sample.ts'), 'export const sample = true\n')
    await writeNote('inbox/snippet-note', '<<< ./examples/sample.ts')
    await writeNote('inbox/broken-note', '<!--@include: ./missing.md-->')

    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const result = await index.query({ kind: 'vault-file', path: 'inbox/examples/sample.ts' })

    expect(result.references).toEqual([expect.objectContaining({
      owner: expect.objectContaining({ id: 'inbox/snippet-note' }),
      kind: 'note-snippet',
      relation: 'direct',
      line: 1,
    })])
    expect(result.coverage.currentNotes).toBe('partial')
    expect(result.currentFinding).toBe('in-use')
  })

  it('does not invent source line numbers for resources inside a selected Include range', async () => {
    await fs.mkdir(path.join(root, 'inbox', 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'selected.png'), Buffer.from([1, 2, 3]))
    await writeNote('inbox/part', [
      'unused line',
      '![Selected](./assets/selected.png)',
      'unused line',
    ].join('\n'))
    await writeNote('inbox/consumer', '<!--@include: ./part.md{2}-->')

    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const result = await index.query({ kind: 'vault-file', path: 'inbox/assets/selected.png' })
    const indirect = result.references.find((reference) => reference.owner.id === 'inbox/consumer')

    expect(indirect).toMatchObject({ relation: 'indirect', sourcePath: 'inbox/part' })
    expect(indirect).not.toHaveProperty('line')
  })

  it('uses live Board scene and thumbnail references and projects Note-to-Board dependencies', async () => {
    addAsset()
    addBoard(boardA, 'Architecture Board')
    addBoard(boardB, 'Second Board')
    addBoardAssetReference(assetId, boardA, 'scene')
    addBoardAssetReference(assetId, boardA, 'thumbnail')
    addBoardAssetReference(assetId, boardB, 'scene')
    await writeNote('inbox/architecture-note', `![Board](board:${boardA})`)

    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const result = await index.query({ kind: 'asset', id: assetId })

    expect(result.referenceCount).toBe(4)
    expect(result.ownerCount).toBe(3)
    expect(result.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: expect.objectContaining({ id: boardA, title: 'Architecture Board' }), kind: 'board-scene', relation: 'direct' }),
      expect.objectContaining({ owner: expect.objectContaining({ id: boardA }), kind: 'board-thumbnail', relation: 'direct' }),
      expect.objectContaining({ owner: expect.objectContaining({ id: boardB }), kind: 'board-scene', relation: 'direct' }),
      expect.objectContaining({
        owner: expect.objectContaining({ kind: 'note', id: 'inbox/architecture-note' }),
        kind: 'board-embed',
        relation: 'indirect',
        via: [expect.objectContaining({ kind: 'board', id: boardA })],
      }),
    ]))

    const projection = index.getCatalogProjection()!
    expect(projection.get(`asset:${assetId}`)).toEqual({ referenceStatus: 'referenced', referenceCount: 4, ownerCount: 3 })

    db.prepare('UPDATE boards SET title = ? WHERE id = ?').run('Renamed Board', boardA)
    expect((await index.query({ kind: 'asset', id: assetId })).references.find((reference) => reference.owner.id === boardA)?.owner.title).toBe('Renamed Board')
    db.prepare('DELETE FROM boards WHERE id = ?').run(boardB)
    const afterDelete = await index.query({ kind: 'asset', id: assetId })
    expect(afterDelete.references.some((reference) => reference.owner.id === boardB)).toBe(false)
  })

  it('never declares Board Materials unused and never issues a deletion permission', async () => {
    db.prepare(`INSERT INTO board_materials (id, name, kind, content, archived, created_at, updated_at)
      VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Material', 'svg', '<svg/>', 0, 1, 1)`).run()
    const index = new AttachmentReferenceIndex(db)
    await index.refresh()
    const preview = await index.preview({ kind: 'board-material', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })

    expect(preview.currentFinding).toBe('unknown')
    expect(preview.riskLevel).toBe('unverified')
    expect(preview.deletionAllowed).toBe(false)
    expect(preview.coverage).toMatchObject({
      historicalVersions: 'not-checked',
      unsavedDrafts: 'not-checked',
      protectedDiary: 'restricted',
      boardCheckpoints: 'not-checked',
    })
  })

  it('retains the last good snapshot as stale after a failed refresh, reports unknown risk, and recovers on retry', async () => {
    await fs.mkdir(path.join(root, 'inbox', 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'diagram.png'), Buffer.from([1, 2, 3]))
    await writeNote('inbox/diagram-note', '![Diagram](./assets/diagram.png)')
    let fail = false
    let now = 100
    const index = new AttachmentReferenceIndex(db, {
      root: () => {
        if (fail) throw new Error('/private/vault/path must not escape')
        return root
      },
      now: () => now,
    })
    const resource = { kind: 'vault-file' as const, path: 'inbox/assets/diagram.png' }

    await index.refresh()
    const lastGoodPage = await index.query(resource)
    expect(lastGoodPage).toMatchObject({ stale: false, currentFinding: 'in-use', checkedAt: 100 })
    const lastGoodStatus = index.getStatus()

    fail = true
    now = 200
    await expect(index.refresh(true)).rejects.toThrow('Attachment reference scan failed')

    expect(index.getStatus()).toMatchObject({
      state: 'stale',
      complete: false,
      refreshedAt: lastGoodStatus.refreshedAt,
      snapshotId: lastGoodStatus.snapshotId,
      coverage: { currentNotes: 'unknown', boardReferences: 'unknown' },
    })
    const stalePage = await index.query(resource)
    expect(stalePage).toMatchObject({
      stale: true,
      currentFinding: 'unknown',
      referenceCount: 1,
      snapshotId: lastGoodStatus.snapshotId,
      checkedAt: lastGoodPage.checkedAt,
      coverage: { currentNotes: 'unknown', boardReferences: 'unknown' },
    })
    expect(index.getCatalogProjection()?.get('vault-file:inbox/assets/diagram.png')).toEqual({
      referenceStatus: 'unknown',
      referenceCount: 0,
      ownerCount: 0,
    })
    const preview = await index.preview(resource)
    expect(preview).toMatchObject({
      stale: true,
      currentFinding: 'unknown',
      riskLevel: 'unverified',
      deletionAllowed: false,
      snapshotId: lastGoodStatus.snapshotId,
    })
    expect(preview.riskReasons).toContain('current-scan-incomplete')

    fail = false
    now = 300
    await index.refresh(true)
    expect(index.getStatus()).toMatchObject({ state: 'ready', refreshedAt: 300, coverage: { currentNotes: 'complete' } })
    expect(await index.query(resource)).toMatchObject({ stale: false, currentFinding: 'in-use', checkedAt: 300 })
  })

  it('keeps an initial build failure retryable without publishing an empty snapshot', async () => {
    let fail = true
    const index = new AttachmentReferenceIndex(db, {
      root: () => {
        if (fail) throw new Error('temporary scan failure')
        return root
      },
    })

    await expect(index.refresh()).rejects.toMatchObject({ code: 'ATTACHMENT_REFERENCES_UNAVAILABLE', status: 503 })
    expect(index.getStatus()).toMatchObject({
      state: 'failed',
      complete: null,
      noteCount: 0,
      refreshedAt: null,
      snapshotId: null,
    })

    fail = false
    await index.refresh()
    expect(index.getStatus()).toMatchObject({ state: 'ready', complete: true })
  })

  it('does not let consecutive superseded scans overwrite or clear the newest scan state', async () => {
    const index = new AttachmentReferenceIndex(db)
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const third = deferred<unknown>()
    const buildSnapshot = vi.spyOn(index as unknown as {
      buildSnapshot: (signal: AbortSignal) => Promise<unknown>
    }, 'buildSnapshot')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
    const makeSnapshot = (snapshotId: string) => ({
      referencesByResource: new Map(),
      boardEmbedsByBoard: new Map(),
      titles: new Map(),
      fingerprints: new Map(),
      noteCount: 2,
      coverage: 'complete',
      refreshedAt: 300,
      snapshotId,
    })

    const obsoleteRefresh = index.refresh()
    const waitingRead = index.ensureReady()
    const supersededRefresh = index.refresh(true)
    const currentRefresh = index.refresh(true)
    first.reject(new Error('obsolete scan failure'))
    await obsoleteRefresh
    expect(index.getStatus().state).toBe('building')
    second.reject(new Error('superseded scan failure'))
    await supersededRefresh
    expect(index.getStatus().state).toBe('building')
    third.resolve(makeSnapshot('new-snapshot'))
    await currentRefresh
    await waitingRead

    expect(index.getStatus()).toMatchObject({ state: 'ready', snapshotId: 'new-snapshot', noteCount: 2 })
    expect(buildSnapshot).toHaveBeenCalledTimes(3)
  })

  it('excludes encrypted Diary content and bounds the derived snapshot at the 1k and 10k Note scale', async () => {
    const diaryRoot = path.join(root, 'diary-only')
    await fs.mkdir(path.join(diaryRoot, 'diary', '2026-10-12'), { recursive: true })
    await fs.writeFile(path.join(diaryRoot, 'diary', '2026-10-12', 'private.md'), '# PRIVATE_DIARY_BODY_MARKER')
    const diaryIndex = new AttachmentReferenceIndex(db, { root: () => diaryRoot })
    await diaryIndex.refresh()
    expect(diaryIndex.getStatus()).toMatchObject({ noteCount: 0, coverage: { currentNotes: 'complete' } })
    expect(JSON.stringify((diaryIndex as unknown as { snapshot: unknown }).snapshot)).not.toContain('PRIVATE_DIARY_BODY_MARKER')
    const smallRoot = path.join(root, 'small')
    await fs.mkdir(smallRoot, { recursive: true })
    for (let index = 0; index < 1_000; index += 1) {
      await fs.writeFile(path.join(smallRoot, `note-${String(index).padStart(4, '0')}.md`), `# note ${index}\ncontent-${index}`)
    }
    const smallIndex = new AttachmentReferenceIndex(db, { root: () => smallRoot, maxNotes: 1_100 })
    await smallIndex.refresh()
    expect(smallIndex.getStatus()).toMatchObject({ state: 'ready', noteCount: 1_000, coverage: { currentNotes: 'complete' } })

    const largeRoot = path.join(root, 'large')
    await fs.mkdir(largeRoot, { recursive: true })
    for (let index = 0; index < 10_000; index += 1) {
      await fs.writeFile(path.join(largeRoot, `note-${String(index).padStart(5, '0')}.md`), `# note ${index}\ncontent-${index}`)
    }
    const largeIndex = new AttachmentReferenceIndex(db, { root: () => largeRoot, maxNotes: 10_100 })
    await largeIndex.refresh()
    expect(largeIndex.getStatus()).toMatchObject({ state: 'ready', noteCount: 10_000, coverage: { currentNotes: 'complete' } })
    const snapshot = (largeIndex as unknown as { snapshot: unknown }).snapshot
    expect(JSON.stringify(snapshot)).not.toContain('content-9999')
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_DIARY_BODY_MARKER')
  }, 15_000)
})
