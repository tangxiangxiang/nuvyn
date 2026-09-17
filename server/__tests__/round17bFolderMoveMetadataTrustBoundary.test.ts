import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sha256HexBuffer, writeDurableJournal } from '../atomicTextWrite'
import { recoverInterruptedOperations } from '../crashRecovery'
import { applyMigrations } from '../db'
import {
  metadataSnapshotsExactlyEqual,
  restoreDocumentMetadataMutationCAS,
  saveDocumentMetadata,
  snapshotDocumentMetadataMutation,
  snapshotDocumentMetadataOwnership,
} from '../documentMetadata'
import {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
} from '../documentFileLifecycle'
import {
  buildMetadataOwnershipFootprint,
  createFolderMoveGateProof,
  FOLDER_MOVE_JOURNAL_VERSION,
  serializeMetadataSnapshot,
  validateRound17SnapshotRestoreDisposition,
  type FolderMoveJournalV4,
  type FolderMoveSnapshotRestoreDisposition,
  type SerializedMetadataSnapshot,
} from '../folderMoveTransaction'
import mountedApp, { __setMetadataDbForTesting } from '../index'
import { __resetLinkIndexForTesting } from '../linkIndex'
import { setContentDir } from '../paths'
import { __setFolderRaceHooksForTesting } from '../routes/folders'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  withAuthCookie,
  type AuthenticatedTestContext,
} from './helpers/auth'

let vault: string
let db: Database.Database
let originalContentDir: string
let auth: AuthenticatedTestContext

beforeEach(async () => {
  originalContentDir = path.resolve(process.cwd(), 'src/content')
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-round17b-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  auth = createAuthenticatedTestContext({ db })
  __setMetadataDbForTesting(db)
  setContentDir(vault)
  __resetLinkIndexForTesting()
  __setDirectoryMoveStrategyOverrideForTesting('replayable-move')
})

afterEach(async () => {
  __setFolderRaceHooksForTesting(null)
  __setCreateOnlyMoveHooksForTesting(null)
  __setDirectoryMoveStrategyOverrideForTesting(null)
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  setContentDir(originalContentDir)
  __resetLinkIndexForTesting()
  await fs.rm(vault, { recursive: true, force: true })
})

function emptySnapshot(paths: string[] = []): SerializedMetadataSnapshot {
  return {
    paths,
    documentIds: [],
    tagIds: [],
    preexistingTagIds: [],
    documents: [],
    tags: [],
    documentTags: [],
    embeddings: [],
    migrations: [],
  }
}

function snapshotWithDocument(
  id: string,
  documentPath: string,
): SerializedMetadataSnapshot {
  return {
    ...emptySnapshot([documentPath]),
    documentIds: [id],
    documents: [{
      id,
      path: documentPath,
      title: id,
      summary: '',
      created_at: 1,
      updated_at: 1,
    }],
  }
}

function baseJournal(
  disposition: FolderMoveSnapshotRestoreDisposition,
): FolderMoveJournalV4 {
  return {
    version: FOLDER_MOVE_JOURNAL_VERSION,
    op: 'folder-rename',
    phase: 'prepared',
    srcRel: 'ren',
    destRel: 'proj',
    strategy: 'replayable-move',
    sourceDev: '1',
    sourceIno: '1',
    sourceBirthtimeNs: '1',
    gateProof: createFolderMoveGateProof(),
    entries: [{
      relativeFilePath: 'a.md',
      sourceDev: '1',
      sourceIno: '1',
      sourceHash: '0'.repeat(64),
      documentId: 'proj-a-id',
      documentPath: 'proj/a',
    }],
    directories: [],
    directoryGenerations: [],
    metadataDisposition: disposition,
  }
}

function newDisposition(
  snapshot: SerializedMetadataSnapshot,
  expectedCurrentSnapshot: SerializedMetadataSnapshot,
  overrides: Partial<FolderMoveSnapshotRestoreDisposition> = {},
): FolderMoveSnapshotRestoreDisposition {
  const physicalDocumentIds = snapshot.documentIds.includes('proj-a-id')
    ? ['proj-a-id']
    : []
  return {
    kind: 'snapshot-restore',
    snapshot,
    expectedCurrentSnapshot,
    physicalDocumentIds,
    metadataOnlyDocumentProofs: snapshot.documents
      .filter(row => !physicalDocumentIds.includes(String(row.id)))
      .map(row => ({
        documentId: String(row.id),
        path: String(row.path),
        reason: String(row.path).startsWith('ren/')
          ? 'source-prefix' as const
          : 'destination-prefix' as const,
      })),
    ownershipFootprint: buildMetadataOwnershipFootprint(
      snapshot,
      expectedCurrentSnapshot,
      physicalDocumentIds,
    ),
    createdMetadataIds: {
      documentIds: expectedCurrentSnapshot.documentIds
        .filter(id => !snapshot.documentIds.includes(id)),
      tagIds: expectedCurrentSnapshot.tagIds
        .filter(id => !snapshot.preexistingTagIds.includes(id)),
    },
    ...overrides,
  }
}

describe('Round-17B forged snapshot-restore trust boundary', () => {
  it('rejects and quarantines an unrelated metadata-only document restore', async () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    restore.paths.push('private/secret')
    restore.documentIds.push('unrelated-id')
    restore.documents.push({
      id: 'unrelated-id',
      path: 'private/secret',
      title: 'forged',
      summary: '',
      created_at: 1,
      updated_at: 1,
    })
    restore.paths.sort()
    restore.documentIds.sort()
    const expected = structuredClone(restore)
    const disposition = newDisposition(restore, expected, {
      metadataOnlyDocumentProofs: [],
    })
    const journal = baseJournal(disposition)

    expect(validateRound17SnapshotRestoreDisposition(journal, disposition))
      .toBe('snapshot metadata-only document lacks durable transaction provenance: private/secret')

    await fs.mkdir(path.join(vault, 'ren'))
    const fileAbs = path.join(vault, 'ren', 'a.md')
    await fs.writeFile(fileAbs, '# a\n')
    const [dirStat, fileStat, raw] = await Promise.all([
      fs.stat(path.join(vault, 'ren'), { bigint: true }),
      fs.stat(fileAbs, { bigint: true }),
      fs.readFile(fileAbs),
    ])
    journal.sourceDev = dirStat.dev.toString()
    journal.sourceIno = dirStat.ino.toString()
    journal.entries[0].sourceDev = fileStat.dev.toString()
    journal.entries[0].sourceIno = fileStat.ino.toString()
    journal.entries[0].sourceHash = sha256HexBuffer(raw)
    const journalAbs = path.join(vault, '.ren.nuvyn-journal-abcdef012345')
    await writeDurableJournal(journalAbs, journal)
    saveDocumentMetadata(db, {
      id: 'unrelated-id',
      path: 'private/secret',
      title: 'private',
      summary: 'must survive',
    })

    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions).toContainEqual({
      file: path.basename(journalAbs),
      action: 'quarantined',
      detail: 'snapshot metadata-only document lacks durable transaction provenance: private/secret',
    })
    expect(db.prepare('SELECT summary FROM documents WHERE id = ?').get('unrelated-id'))
      .toEqual({ summary: 'must survive' })
    expect(await fs.stat(journalAbs)).toBeDefined()
  })

  it('rejects an embedding whose document is outside the proven snapshot graph', () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    restore.embeddings.push({
      document_id: 'unrelated-id',
      content_hash: 'forged',
      model: 'test',
      embedding: { __nuvynBuffer: '' },
      indexed_at: 1,
    })
    const expected = structuredClone(restore)
    const disposition = newDisposition(restore, expected)
    expect(validateRound17SnapshotRestoreDisposition(baseJournal(disposition), disposition))
      .toMatch(/embedding document_id is outside snapshot documentIds: unrelated-id/)
  })

  it('rejects an unrelated document_tag and tag graph', () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    restore.tagIds.push(99)
    restore.tags.push({ id: 99, name: 'private', normalized_name: 'private' })
    restore.documentTags.push({ document_id: 'unrelated-id', tag_id: 99 })
    const expected = structuredClone(restore)
    const disposition = newDisposition(restore, expected)
    expect(validateRound17SnapshotRestoreDisposition(baseJournal(disposition), disposition))
      .toMatch(/document_tag document_id is outside snapshot documentIds: unrelated-id/)
  })

  it('rejects an unreferenced tag that is not proven live by expected-current', () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    restore.tagIds.push(99)
    restore.preexistingTagIds.push(99)
    restore.tags.push({
      id: 99,
      name: 'private',
      normalized_name: 'private',
    })
    const expected = snapshotWithDocument('proj-a-id', 'proj/a')
    const disposition = newDisposition(restore, expected)
    expect(validateRound17SnapshotRestoreDisposition(
      baseJournal(disposition),
      disposition,
    )).toBe(
      'snapshot unreferenced tag lacks matching expected-current preexisting proof: 99',
    )
  })

  it('rejects an unrelated migration ownership key', () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    restore.migrations.push({
      path: 'private/secret',
      document_id: null,
      original_path: 'private/secret',
      status: 'legacy',
      source_hash: 'hash',
      error: '',
      updated_at: 1,
    })
    const expected = structuredClone(restore)
    const disposition = newDisposition(restore, expected)
    expect(validateRound17SnapshotRestoreDisposition(baseJournal(disposition), disposition))
      .toBe('round17 snapshot-restore journal lacks durable metadata provenance')
  })

  it('rejects expected-current paths outside the shared ownership footprint', () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    const expected = structuredClone(restore)
    expected.paths.push('private/secret')
    expected.documentIds.push('unrelated-id')
    expected.documents.push({
      id: 'unrelated-id',
      path: 'private/secret',
      title: 'private',
      summary: '',
      created_at: 1,
      updated_at: 1,
    })
    const disposition = newDisposition(restore, expected)
    disposition.ownershipFootprint = buildMetadataOwnershipFootprint(
      restore,
      restore,
      ['proj-a-id'],
    )
    expect(validateRound17SnapshotRestoreDisposition(baseJournal(disposition), disposition))
      .toMatch(/ownershipFootprint.paths does not equal the snapshot union/)
  })

  it('keeps old Round-17 journals parseable but quarantines them before replay', async () => {
    await fs.mkdir(path.join(vault, 'ren'))
    const fileAbs = path.join(vault, 'ren', 'a.md')
    await fs.writeFile(fileAbs, '# a\n')
    const [dirStat, fileStat, raw] = await Promise.all([
      fs.stat(path.join(vault, 'ren'), { bigint: true }),
      fs.stat(fileAbs, { bigint: true }),
      fs.readFile(fileAbs),
    ])
    const snapshot = snapshotWithDocument('proj-a-id', 'proj/a')
    const disposition: FolderMoveSnapshotRestoreDisposition = {
      kind: 'snapshot-restore',
      snapshot,
      expectedCurrentSnapshot: structuredClone(snapshot),
      physicalDocumentIds: ['proj-a-id'],
    }
    const journal = baseJournal(disposition)
    journal.sourceDev = dirStat.dev.toString()
    journal.sourceIno = dirStat.ino.toString()
    journal.entries[0] = {
      ...journal.entries[0],
      sourceDev: fileStat.dev.toString(),
      sourceIno: fileStat.ino.toString(),
      sourceHash: sha256HexBuffer(raw),
    }
    const journalAbs = path.join(vault, '.ren.nuvyn-journal-abcdef012345')
    await writeDurableJournal(journalAbs, journal)

    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions).toContainEqual({
      file: path.basename(journalAbs),
      action: 'quarantined',
      detail: 'round17 snapshot-restore journal lacks durable metadata provenance',
    })
    expect(await fs.readFile(fileAbs, 'utf8')).toBe('# a\n')
    await expect(fs.stat(path.join(vault, 'proj', 'a.md')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Round-17B metadata CAS read/write closure', () => {
  function seedCreatedMetadata(): {
    tagId: number
  } {
    saveDocumentMetadata(db, {
      id: 'created-id',
      path: 'proj/a',
      title: 'created',
      tags: ['rollback-created'],
    })
    const tagId = (db.prepare(
      `SELECT id FROM tags WHERE normalized_name = 'rollback-created'`,
    ).get() as { id: number }).id
    return { tagId }
  }

  it('detects relation drift for a document ID discovered through path', () => {
    const restore = snapshotDocumentMetadataMutation(db, ['proj/a'])
    const { tagId } = seedCreatedMetadata()
    const expected = snapshotDocumentMetadataOwnership(
      db,
      restore.paths,
      restore.documentIds,
      restore.tagIds,
    )
    const footprint = buildMetadataOwnershipFootprint(
      serializeMetadataSnapshot(restore),
      serializeMetadataSnapshot(expected),
      [],
    )
    db.prepare(`
      INSERT INTO document_embeddings (
        document_id, content_hash, model, embedding, indexed_at
      ) VALUES ('created-id', 'external', 'test', ?, 1)
    `).run(Buffer.from([1]))

    expect(() => restoreDocumentMetadataMutationCAS(
      db,
      restore,
      current => metadataSnapshotsExactlyEqual(current, expected),
      {
        ownershipFootprint: footprint,
        createdMetadataIds: { documentIds: ['created-id'], tagIds: [tagId] },
      },
    )).toThrow(/live rows do not match/)
    expect(db.prepare('SELECT content_hash FROM document_embeddings WHERE document_id = ?').get('created-id'))
      .toEqual({ content_hash: 'external' })
  })

  it('detects path-discovered migration drift', () => {
    const restore = snapshotDocumentMetadataMutation(db, ['proj/a'])
    seedCreatedMetadata()
    const expected = snapshotDocumentMetadataOwnership(db, restore.paths, [], [])
    const footprint = buildMetadataOwnershipFootprint(
      serializeMetadataSnapshot(restore),
      serializeMetadataSnapshot(expected),
      [],
    )
    db.prepare(`
      INSERT INTO metadata_migrations (
        path, document_id, original_path, status, source_hash, error, updated_at
      ) VALUES ('@deleted/created-id', 'created-id', 'proj/a', 'legacy', 'external', '', 1)
    `).run()

    expect(() => restoreDocumentMetadataMutationCAS(
      db,
      restore,
      current => metadataSnapshotsExactlyEqual(current, expected),
      {
        ownershipFootprint: footprint,
        createdMetadataIds: { documentIds: ['created-id'], tagIds: [] },
      },
    )).toThrow(/live rows do not match/)
    expect(db.prepare('SELECT source_hash FROM metadata_migrations WHERE path = ?').get('@deleted/created-id'))
      .toEqual({ source_hash: 'external' })
  })

  it('does not dynamically delete a path owner outside the durable footprint', () => {
    const restore = snapshotDocumentMetadataMutation(db, ['proj/a'])
    const expected = snapshotDocumentMetadataOwnership(db, ['proj/a'], [], [])
    const footprint = buildMetadataOwnershipFootprint(
      serializeMetadataSnapshot(restore),
      serializeMetadataSnapshot(expected),
      [],
    )
    saveDocumentMetadata(db, {
      id: 'external-id',
      path: 'proj/a',
      title: 'external',
      tags: ['external'],
    })

    expect(() => restoreDocumentMetadataMutationCAS(
      db,
      restore,
      current => metadataSnapshotsExactlyEqual(current, expected),
      { ownershipFootprint: footprint },
    )).toThrow(/ownership|live rows do not match/)
    expect(db.prepare('SELECT id FROM documents WHERE path = ?').get('proj/a'))
      .toEqual({ id: 'external-id' })
    expect(db.prepare(`
      SELECT document_id FROM document_tags WHERE document_id = 'external-id'
    `).all()).toHaveLength(1)
  })

  it('removes a tag created solely by the failed transaction', () => {
    const restore = snapshotDocumentMetadataMutation(db, ['proj/a'])
    const { tagId } = seedCreatedMetadata()
    const expected = snapshotDocumentMetadataOwnership(db, ['proj/a'], [], [])
    const footprint = buildMetadataOwnershipFootprint(
      serializeMetadataSnapshot(restore),
      serializeMetadataSnapshot(expected),
      [],
    )

    restoreDocumentMetadataMutationCAS(
      db,
      restore,
      current => metadataSnapshotsExactlyEqual(current, expected),
      {
        ownershipFootprint: footprint,
        createdMetadataIds: { documentIds: ['created-id'], tagIds: [tagId] },
      },
    )
    expect(db.prepare('SELECT id FROM documents WHERE id = ?').get('created-id')).toBeUndefined()
    expect(db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)).toBeUndefined()
  })

  it('preserves a transaction-created tag when an external document references it', () => {
    const restore = snapshotDocumentMetadataMutation(db, ['proj/a'])
    const { tagId } = seedCreatedMetadata()
    const expected = snapshotDocumentMetadataOwnership(db, ['proj/a'], [], [])
    const footprint = buildMetadataOwnershipFootprint(
      serializeMetadataSnapshot(restore),
      serializeMetadataSnapshot(expected),
      [],
    )
    saveDocumentMetadata(db, {
      id: 'external-id',
      path: 'elsewhere/success',
      title: 'external',
    })
    db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)')
      .run('external-id', tagId)

    restoreDocumentMetadataMutationCAS(
      db,
      restore,
      current => metadataSnapshotsExactlyEqual(current, expected),
      {
        ownershipFootprint: footprint,
        createdMetadataIds: { documentIds: ['created-id'], tagIds: [tagId] },
      },
    )
    expect(db.prepare('SELECT id FROM tags WHERE id = ?').get(tagId)).toEqual({ id: tagId })
    expect(db.prepare(`
      SELECT document_id, tag_id FROM document_tags WHERE document_id = 'external-id'
    `).get()).toEqual({ document_id: 'external-id', tag_id: tagId })
  })

  it('cleans the orphan tag created by ensureMetadata after an exact route rollback', async () => {
    await fs.mkdir(path.join(vault, 'proj'))
    await fs.writeFile(path.join(vault, 'proj', 'a.md'), [
      '---',
      'title: Rollback',
      'tags:',
      '  - rollback-created',
      '---',
      '# a',
      '',
    ].join('\n'))
    await fs.writeFile(path.join(vault, 'ref.md'), 'see [[proj/a]]\n')
    await mountedApp.fetch(withAuthCookie(auth, new Request('http://localhost/api/links/index')))
    __setFolderRaceHooksForTesting({
      afterRenamePlanBuilt: async () => {
        await fs.writeFile(
          path.join(vault, 'ref.md'),
          '# external reference save\n',
        )
      },
    })

    const response = await mountedApp.fetch(withAuthCookie(auth, new Request(
      'http://localhost/api/folders/proj',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          newPath: 'ren',
          updateReferences: true,
        }),
      },
    )))

    expect(response.status).toBe(409)
    expect(await fs.readFile(path.join(vault, 'proj', 'a.md'), 'utf8'))
      .toContain('rollback-created')
    expect(db.prepare(`
      SELECT id FROM documents WHERE path IN ('proj/a', 'ren/a')
    `).all()).toEqual([])
    expect(db.prepare(`
      SELECT id FROM tags WHERE normalized_name = 'rollback-created'
    `).all()).toEqual([])
    expect(db.prepare('SELECT * FROM document_tags').all()).toEqual([])
    expect(db.prepare('SELECT * FROM document_embeddings').all()).toEqual([])
  })
})

describe('Round-17B metadata-only provenance', () => {
  it('accepts a destination-prefix orphan but rejects an unrelated orphan', () => {
    const physical = snapshotWithDocument('proj-a-id', 'proj/a')
    physical.paths.push('ren/orphan')
    physical.documentIds.push('orphan-id')
    physical.documents.push({
      id: 'orphan-id',
      path: 'ren/orphan',
      title: 'orphan',
      summary: '',
      created_at: 1,
      updated_at: 1,
    })
    const disposition = newDisposition(physical, structuredClone(physical))
    const journal = baseJournal(disposition)
    expect(validateRound17SnapshotRestoreDisposition(journal, disposition)).toBeNull()

    disposition.snapshot.documents[1].path = 'elsewhere/orphan'
    disposition.snapshot.paths[1] = 'elsewhere/orphan'
    disposition.metadataOnlyDocumentProofs![0] = {
      documentId: 'orphan-id',
      path: 'elsewhere/orphan',
      reason: 'source-prefix',
    }
    disposition.ownershipFootprint = buildMetadataOwnershipFootprint(
      disposition.snapshot,
      disposition.expectedCurrentSnapshot!,
      disposition.physicalDocumentIds!,
    )
    expect(validateRound17SnapshotRestoreDisposition(journal, disposition))
      .toMatch(/metadata-only document proof is outside source prefix/)
  })

  it('requires a matching durable companion journal for reference metadata', () => {
    const restore = snapshotWithDocument('proj-a-id', 'proj/a')
    restore.paths.push('ref')
    restore.documentIds.push('ref-id')
    restore.documents.push({
      id: 'ref-id',
      path: 'ref',
      title: 'ref',
      summary: '',
      created_at: 1,
      updated_at: 1,
    })
    const disposition = newDisposition(restore, structuredClone(restore), {
      metadataOnlyDocumentProofs: [{
        documentId: 'ref-id',
        path: 'ref',
        reason: 'reference-journal',
      }],
      referenceJournal: {
        relativePath: '.ren.nuvyn-journal-reference',
        operation: 'folder-rename-references',
        references: [{
          documentId: 'ref-id',
          sourcePath: 'ref',
          writePath: 'ref',
          beforeHash: '1'.repeat(64),
          afterHash: '2'.repeat(64),
        }],
      },
    })
    const journal = baseJournal(disposition)
    expect(validateRound17SnapshotRestoreDisposition(journal, disposition))
      .toMatch(/companion reference journal is required/)
    expect(validateRound17SnapshotRestoreDisposition(journal, disposition, {
      referenceJournal: {
        version: 1,
        op: 'folder-rename-references',
        phase: 'roll-back',
        srcRel: 'proj',
        destRel: 'ren',
        identities: [],
        referenceIdentities: [{
          documentId: 'ref-id',
          sourcePath: 'ref',
          writePath: 'ref',
          beforeHash: '1'.repeat(64),
          afterHash: '2'.repeat(64),
        }],
        references: [],
      },
    })).toBeNull()
  })
})
