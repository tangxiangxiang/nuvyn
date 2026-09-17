import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

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
  buildMetadataOwnershipFootprint,
  createFolderMoveGateProof,
  FOLDER_MOVE_JOURNAL_VERSION,
  serializeMetadataSnapshot,
  validateRound17SnapshotRestoreDisposition,
  type FolderMoveJournalV4,
  type FolderMoveReferenceJournalProof,
  type FolderMoveSnapshotRestoreDisposition,
  type ParsedFolderRenameReferenceJournal,
  type SerializedMetadataSnapshot,
} from '../folderMoveTransaction'

const BEFORE_RAW = 'before'
const AFTER_RAW = 'after'
const BEFORE_HASH = sha256HexBuffer(Buffer.from(BEFORE_RAW))
const AFTER_HASH = sha256HexBuffer(Buffer.from(AFTER_RAW))

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

function addDocument(
  snapshot: SerializedMetadataSnapshot,
  documentId: string,
  documentPath: string,
): void {
  snapshot.paths.push(documentPath)
  snapshot.paths.sort()
  snapshot.documentIds.push(documentId)
  snapshot.documentIds.sort()
  snapshot.documents.push({
    id: documentId,
    path: documentPath,
    title: documentId,
    summary: '',
    created_at: 1,
    updated_at: 1,
  })
  snapshot.documents.sort((left, right) =>
    String(left.id).localeCompare(String(right.id)))
}

function physicalSnapshot(): SerializedMetadataSnapshot {
  const snapshot = emptySnapshot()
  addDocument(snapshot, 'proj-a-id', 'proj/a')
  return snapshot
}

function addTag(
  snapshot: SerializedMetadataSnapshot,
  tagId: number,
  documentId?: string,
): void {
  snapshot.tagIds.push(tagId)
  snapshot.tagIds.sort((left, right) => left - right)
  snapshot.tags.push({
    id: tagId,
    name: `tag-${tagId}`,
    normalized_name: `tag-${tagId}`,
  })
  snapshot.tags.sort((left, right) => Number(left.id) - Number(right.id))
  if (documentId) {
    snapshot.documentTags.push({
      document_id: documentId,
      tag_id: tagId,
    })
  }
}

function referenceRow(
  documentId: string,
  sourcePath: string,
  writePath: string,
): FolderMoveReferenceJournalProof['references'][number] {
  return {
    documentId,
    sourcePath,
    writePath,
    beforeHash: BEFORE_HASH,
    afterHash: AFTER_HASH,
  }
}

function referenceProof(
  references: FolderMoveReferenceJournalProof['references'],
  relativePath = '.proj.nuvyn-journal-fedcba987654',
): FolderMoveReferenceJournalProof {
  return {
    relativePath,
    operation: 'folder-rename-references',
    references,
  }
}

function parsedReferenceJournal(
  references: FolderMoveReferenceJournalProof['references'],
): ParsedFolderRenameReferenceJournal {
  return {
    version: 1,
    op: 'folder-rename-references',
    phase: 'roll-back',
    srcRel: 'proj',
    destRel: 'ren',
    identities: [],
    referenceIdentities: references,
    references: [],
  }
}

function dispositionFor(
  restore: SerializedMetadataSnapshot,
  expected: SerializedMetadataSnapshot,
  overrides: Partial<FolderMoveSnapshotRestoreDisposition> = {},
): FolderMoveSnapshotRestoreDisposition {
  const physicalDocumentIds = restore.documentIds.includes('proj-a-id')
    ? ['proj-a-id']
    : []
  const metadataOnlyDocumentProofs = restore.documents
    .filter(row => !physicalDocumentIds.includes(String(row.id)))
    .filter(row =>
      String(row.path) === 'ren'
      || String(row.path).startsWith('ren/')
      || String(row.path) === 'proj'
      || String(row.path).startsWith('proj/'))
    .map(row => ({
      documentId: String(row.id),
      path: String(row.path),
      reason: String(row.path) === 'ren'
        || String(row.path).startsWith('ren/')
        ? 'source-prefix' as const
        : 'destination-prefix' as const,
    }))
    .sort((left, right) => left.documentId.localeCompare(right.documentId))
  return {
    kind: 'snapshot-restore',
    snapshot: restore,
    expectedCurrentSnapshot: expected,
    physicalDocumentIds,
    metadataOnlyDocumentProofs,
    ownershipFootprint: buildMetadataOwnershipFootprint(
      restore,
      expected,
      physicalDocumentIds,
    ),
    createdMetadataIds: {
      documentIds: expected.documentIds
        .filter(id => !restore.documentIds.includes(id))
        .sort(),
      tagIds: expected.tagIds
        .filter(id => !restore.preexistingTagIds.includes(id))
        .sort((left, right) => left - right),
    },
    ...overrides,
  }
}

function journalFor(
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

function validateWithCompanion(
  disposition: FolderMoveSnapshotRestoreDisposition,
  references: FolderMoveReferenceJournalProof['references'],
): string | null {
  return validateRound17SnapshotRestoreDisposition(
    journalFor(disposition),
    disposition,
    { referenceJournal: parsedReferenceJournal(references) },
  )
}

describe('Round-17C exact reference identity provenance', () => {
  it('rejects the same reference path under a different restore documentId', () => {
    const restore = physicalSnapshot()
    addDocument(restore, 'forged-id', 'ref')
    const expected = physicalSnapshot()
    addDocument(expected, 'real-id', 'ref')
    const references = [referenceRow('real-id', 'ref', 'ref')]
    const disposition = dispositionFor(restore, expected, {
      metadataOnlyDocumentProofs: [{
        documentId: 'forged-id',
        path: 'ref',
        reason: 'reference-journal',
      }],
      referenceJournal: referenceProof(references),
    })

    expect(validateWithCompanion(disposition, references)).toBe(
      'reference metadata proof is absent from companion journal: ref',
    )
  })

  it('rejects an expected-current-only reference whose companion documentId differs', () => {
    const restore = physicalSnapshot()
    const expected = structuredClone(restore)
    addDocument(expected, 'real-id', 'ref')
    const references = [referenceRow('other-id', 'ref', 'ref')]
    const disposition = dispositionFor(restore, expected, {
      referenceJournal: referenceProof(references),
    })

    expect(validateWithCompanion(disposition, references)).toBe(
      'expected-current metadata document lacks durable transaction provenance: ref',
    )
  })

  it('rejects the same documentId when neither companion path is exact', () => {
    const restore = physicalSnapshot()
    addDocument(restore, 'ref-id', 'ref')
    const expected = structuredClone(restore)
    const references = [referenceRow('ref-id', 'other/ref', 'other/ref')]
    const disposition = dispositionFor(restore, expected, {
      metadataOnlyDocumentProofs: [{
        documentId: 'ref-id',
        path: 'ref',
        reason: 'reference-journal',
      }],
      referenceJournal: referenceProof(references),
    })

    expect(validateWithCompanion(disposition, references)).toBe(
      'reference metadata proof is absent from companion journal: ref',
    )
  })

  it('rejects a prefix-like companion path', () => {
    const restore = physicalSnapshot()
    addDocument(restore, 'ref-id', 'ref')
    const expected = structuredClone(restore)
    const references = [referenceRow('ref-id', 'ref/child', 'ref/child')]
    const disposition = dispositionFor(restore, expected, {
      metadataOnlyDocumentProofs: [{
        documentId: 'ref-id',
        path: 'ref',
        reason: 'reference-journal',
      }],
      referenceJournal: referenceProof(references),
    })

    expect(validateWithCompanion(disposition, references)).toBe(
      'reference metadata proof is absent from companion journal: ref',
    )
  })

  it('accepts exact source-path and write-path mappings for the same documentId', () => {
    for (const references of [
      [referenceRow('ref-id', 'ref', 'renamed/ref')],
      [referenceRow('ref-id', 'original/ref', 'ref')],
    ]) {
      const restore = physicalSnapshot()
      addDocument(restore, 'ref-id', 'ref')
      const expected = structuredClone(restore)
      const disposition = dispositionFor(restore, expected, {
        metadataOnlyDocumentProofs: [{
          documentId: 'ref-id',
          path: 'ref',
          reason: 'reference-journal',
        }],
        referenceJournal: referenceProof(references),
      })

      expect(validateWithCompanion(disposition, references)).toBeNull()
    }
  })
})

describe('Round-17C rollback-created tag provenance', () => {
  it('rejects an unreferenced expected-current orphan tag declared as created', () => {
    const restore = physicalSnapshot()
    const expected = structuredClone(restore)
    addTag(expected, 99)
    const disposition = dispositionFor(restore, expected)

    expect(validateRound17SnapshotRestoreDisposition(
      journalFor(disposition),
      disposition,
    )).toBe(
      'created tag lacks durable transaction provenance: 99',
    )
  })

  it('rejects a created tag whose only claimed owner is outside the transaction', () => {
    const restore = physicalSnapshot()
    const expected = structuredClone(restore)
    addDocument(expected, 'unrelated-id', 'private/unrelated')
    addTag(expected, 99, 'unrelated-id')
    const disposition = dispositionFor(restore, expected, {
      createdMetadataIds: {
        documentIds: [],
        tagIds: [99],
      },
    })

    expect(validateRound17SnapshotRestoreDisposition(
      journalFor(disposition),
      disposition,
    )).not.toBeNull()
  })

  it('accepts a created tag referenced by an ensureMetadata-created document', () => {
    const restore = physicalSnapshot()
    const expected = structuredClone(restore)
    addDocument(expected, 'created-id', 'ren/new')
    addTag(expected, 99, 'created-id')
    const disposition = dispositionFor(restore, expected)

    expect(validateRound17SnapshotRestoreDisposition(
      journalFor(disposition),
      disposition,
    )).toBeNull()
  })

  it('accepts a created tag referenced by a physical transaction document', () => {
    const restore = physicalSnapshot()
    const expected = structuredClone(restore)
    addTag(expected, 99, 'proj-a-id')
    const disposition = dispositionFor(restore, expected)

    expect(validateRound17SnapshotRestoreDisposition(
      journalFor(disposition),
      disposition,
    )).toBeNull()
  })

  it('preserves a created tag and external document_tag during strict restore', () => {
    const metadataDb = new Database(':memory:')
    try {
      metadataDb.pragma('foreign_keys = ON')
      applyMigrations(metadataDb)
      const restore = snapshotDocumentMetadataMutation(metadataDb, ['proj/a'])
      saveDocumentMetadata(metadataDb, {
        id: 'created-id',
        path: 'proj/a',
        title: 'created',
        tags: ['rollback-created'],
      })
      const tagId = (metadataDb.prepare(`
        SELECT id FROM tags WHERE normalized_name = 'rollback-created'
      `).get() as { id: number }).id
      const expected = snapshotDocumentMetadataOwnership(
        metadataDb,
        restore.paths,
        restore.documentIds,
        restore.tagIds,
      )
      const footprint = buildMetadataOwnershipFootprint(
        serializeMetadataSnapshot(restore),
        serializeMetadataSnapshot(expected),
        [],
      )
      saveDocumentMetadata(metadataDb, {
        id: 'external-id',
        path: 'elsewhere/success',
        title: 'external',
      })
      metadataDb.prepare(
        'INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)',
      ).run('external-id', tagId)

      restoreDocumentMetadataMutationCAS(
        metadataDb,
        restore,
        current => metadataSnapshotsExactlyEqual(current, expected),
        {
          ownershipFootprint: footprint,
          createdMetadataIds: {
            documentIds: ['created-id'],
            tagIds: [tagId],
          },
        },
      )

      expect(metadataDb.prepare('SELECT id FROM tags WHERE id = ?').get(tagId))
        .toEqual({ id: tagId })
      expect(metadataDb.prepare(`
        SELECT document_id, tag_id
        FROM document_tags
        WHERE document_id = 'external-id'
      `).get()).toEqual({
        document_id: 'external-id',
        tag_id: tagId,
      })
    } finally {
      metadataDb.close()
    }
  })
})

describe('Round-17C recovery trust boundary', () => {
  it('quarantines a forged reference identity without mutating metadata or artifacts', async () => {
    const recoveryVault = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nuvyn-round17c-'),
    )
    const recoveryDb = new Database(':memory:')
    try {
      recoveryDb.pragma('foreign_keys = ON')
      applyMigrations(recoveryDb)
      await fs.mkdir(path.join(recoveryVault, 'ren'))
      const fileAbs = path.join(recoveryVault, 'ren', 'a.md')
      await fs.writeFile(fileAbs, '# a\n')
      const [directoryStat, fileStat, fileRaw] = await Promise.all([
        fs.stat(path.join(recoveryVault, 'ren'), { bigint: true }),
        fs.stat(fileAbs, { bigint: true }),
        fs.readFile(fileAbs),
      ])

      const restore = physicalSnapshot()
      addDocument(restore, 'forged-id', 'ref')
      const expected = physicalSnapshot()
      addDocument(expected, 'real-id', 'ref')
      const references = [referenceRow('real-id', 'ref', 'ref')]
      const companionName = '.proj.nuvyn-journal-fedcba987654'
      const disposition = dispositionFor(restore, expected, {
        metadataOnlyDocumentProofs: [{
          documentId: 'forged-id',
          path: 'ref',
          reason: 'reference-journal',
        }],
        referenceJournal: referenceProof(references, companionName),
      })
      const journal = journalFor(disposition)
      journal.sourceDev = directoryStat.dev.toString()
      journal.sourceIno = directoryStat.ino.toString()
      journal.entries[0] = {
        ...journal.entries[0],
        sourceDev: fileStat.dev.toString(),
        sourceIno: fileStat.ino.toString(),
        sourceHash: sha256HexBuffer(fileRaw),
      }
      const journalName = '.ren.nuvyn-journal-abcdef012345'
      const journalAbs = path.join(recoveryVault, journalName)
      const companionAbs = path.join(recoveryVault, companionName)
      await writeDurableJournal(journalAbs, journal)
      await writeDurableJournal(companionAbs, {
        ...parsedReferenceJournal(references),
        identities: [{
          path: 'proj/a',
          id: 'proj-a-id',
          sourceHash: sha256HexBuffer(fileRaw),
        }],
        references: [{
          path: 'ref',
          beforeHash: BEFORE_HASH,
          afterHash: AFTER_HASH,
          beforePayload: '.proj.nuvyn-ref-before-fedcba987654-0',
          afterPayload: '.proj.nuvyn-ref-after-fedcba987654-0',
        }],
      })
      await fs.writeFile(
        path.join(
          recoveryVault,
          '.proj.nuvyn-ref-before-fedcba987654-0',
        ),
        BEFORE_RAW,
      )
      await fs.writeFile(
        path.join(
          recoveryVault,
          '.proj.nuvyn-ref-after-fedcba987654-0',
        ),
        AFTER_RAW,
      )
      saveDocumentMetadata(recoveryDb, {
        id: 'real-id',
        path: 'ref',
        title: 'real',
        summary: 'must survive',
      })

      const report = await recoverInterruptedOperations(
        recoveryVault,
        recoveryDb,
      )

      expect(report.actions).toContainEqual({
        file: journalName,
        action: 'quarantined',
        detail: 'reference metadata proof is absent from companion journal: ref',
      })
      expect(recoveryDb.prepare(`
        SELECT id, path, summary FROM documents WHERE path = 'ref'
      `).get()).toEqual({
        id: 'real-id',
        path: 'ref',
        summary: 'must survive',
      })
      expect(await fs.stat(journalAbs)).toBeDefined()
      expect(await fs.stat(companionAbs)).toBeDefined()
    } finally {
      recoveryDb.close()
      await fs.rm(recoveryVault, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 10 : 3,
        retryDelay: 100,
      })
    }
  })
})
