import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  rewriteDurableJournal,
  sha256Hex,
  writeDurableJournal,
  writeDurableRecoveryPayload,
} from '../atomicTextWrite'
import { recoverInterruptedOperations } from '../crashRecovery'
import { applyMigrations } from '../db'
import {
  metadataSnapshotsExactlyEqual,
  restoreDocumentMetadataMutationCASIdempotent,
  saveDocumentMetadata,
  snapshotDocumentMetadataOwnership,
} from '../documentMetadata'
import { writeCreateOnlyDurableFile } from '../durableCreateOnlyFile'
import {
  removeDeclaredEmptyDirectories,
} from '../documentFileLifecycle'
import { writeFolderMoveGateProof } from '../folderMoveGateProof'
import { inspectFolderMoveSourceInventory } from '../folderMoveSourceOwnership'
import {
  createFolderMoveGateProof,
  isSerializedMetadataSnapshot,
  type FolderMoveJournalV4,
  type SerializedMetadataSnapshot,
} from '../folderMoveTransaction'
import {
  parseAndValidateDurableRenameReferenceBundle,
  parseRenameReferenceJournalObject,
  prepareRenameReferenceJournal,
} from '../renameReferenceJournal'

let vault: string

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-round17-final-'))
})

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true })
})

async function preparedBundle() {
  const source = path.join(vault, 'proj')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'a.md'), '# a\n')
  const prepared = await prepareRenameReferenceJournal({
    sourceAbs: source,
    op: 'folder-rename-references',
    srcRel: 'proj',
    destRel: 'ren',
    identities: [{
      path: 'proj/a',
      id: 'a-id',
      sourceHash: sha256Hex('# a\n'),
    }],
    references: [{
      path: 'ref',
      beforeRaw: 'before',
      afterRaw: 'after',
    }],
    referenceIdentities: [{
      documentId: 'ref-id',
      sourcePath: 'ref',
      writePath: 'ref',
    }],
  })
  expect(prepared).not.toBeNull()
  return prepared!
}

describe('Round-17 final reference bundle closure', () => {
  it('T1 accepts a production bundle with exact transaction and descriptor binding', async () => {
    const prepared = await preparedBundle()
    const bundle = await parseAndValidateDurableRenameReferenceBundle({
      contentDir: vault,
      journalPath: prepared.journalPath,
    })
    expect(bundle).toMatchObject({
      transactionId: prepared.transactionId,
      descriptorHash: prepared.descriptorHash,
      proofStrength: 'strong',
    })
    expect(bundle?.entry.referenceIdentities?.[0]).toMatchObject({
      documentId: 'ref-id',
      writePath: 'ref',
      beforeHash: bundle?.entry.references[0].beforeHash,
    })
  })

  it('T2/T3 reject identities without an exact operation/hash binding', async () => {
    const prepared = await preparedBundle()
    const missingOperation = structuredClone(prepared.entry)
    missingOperation.references = []
    expect(parseRenameReferenceJournalObject(missingOperation)).toBeNull()

    const mismatchedHash = structuredClone(prepared.entry)
    mismatchedHash.referenceIdentities![0].beforeHash = '0'.repeat(64)
    expect(parseRenameReferenceJournalObject(mismatchedHash)).toBeNull()
  })

  it('T4 fails closed for missing, symlinked, mismatched and misnamed payloads', async () => {
    const prepared = await preparedBundle()
    const before = path.join(
      path.dirname(prepared.journalPath),
      prepared.entry.references[0].beforePayload,
    )
    const original = await fs.readFile(before)

    await fs.rm(before)
    expect(await parseAndValidateDurableRenameReferenceBundle({
      contentDir: vault,
      journalPath: prepared.journalPath,
    })).toBeNull()

    await fs.symlink(path.join(vault, 'proj', 'a.md'), before)
    expect(await parseAndValidateDurableRenameReferenceBundle({
      contentDir: vault,
      journalPath: prepared.journalPath,
    })).toBeNull()

    await fs.rm(before)
    await fs.writeFile(before, 'wrong')
    expect(await parseAndValidateDurableRenameReferenceBundle({
      contentDir: vault,
      journalPath: prepared.journalPath,
    })).toBeNull()

    await fs.writeFile(before, original)
    const misnamed = structuredClone(prepared.entry)
    misnamed.references[0].beforePayload = '.wrong'
    expect(await parseAndValidateDurableRenameReferenceBundle({
      contentDir: vault,
      journalPath: prepared.journalPath,
      value: misnamed,
    })).toBeNull()

    expect(await parseAndValidateDurableRenameReferenceBundle({
      contentDir: path.join(vault, 'proj'),
      journalPath: prepared.journalPath,
    })).toBeNull()
  })

  it('T5 pins a companion and payloads while its owner journal remains', async () => {
    const prepared = await preparedBundle()
    const ownerTransactionId = '12345678-1234-4234-8234-123456789abc'
    const ownerJournal = `.ren.nuvyn-journal-${ownerTransactionId}`
    await prepared.bindFolderSnapshotOwner({
      ownerJournal,
      ownerTransactionId,
    })
    await writeDurableJournal(path.join(vault, ownerJournal), {
      version: 999,
      op: 'retained-owner',
    })
    const rawBefore = await fs.readFile(prepared.journalPath, 'utf8')
    const payloads = prepared.entry.references.flatMap(reference => [
      path.join(vault, reference.beforePayload),
      path.join(vault, reference.afterPayload),
    ])

    const db = new Database(':memory:')
    await recoverInterruptedOperations(vault, db)
    await recoverInterruptedOperations(vault, db)
    db.close()
    expect(await fs.readFile(prepared.journalPath, 'utf8')).toBe(rawBefore)
    for (const payload of payloads) expect(await fs.stat(payload)).toBeDefined()
  })
})

describe('Round-17 idempotent metadata CAS', () => {
  it('T8 returns restored-now, already-restored, then conflict without widening footprint', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    saveDocumentMetadata(db, {
      id: 'a-id',
      path: 'ren/a',
      title: 'a',
      updatedAt: 1,
    })
    const footprint = {
      paths: ['proj/a', 'ren/a'],
      documentIds: ['a-id'],
      tagIds: [],
      migrationPaths: ['proj/a', 'ren/a', '@deleted/a-id'],
      migrationOriginalPaths: ['proj/a', 'ren/a'],
    }
    const expected = snapshotDocumentMetadataOwnership(
      db,
      footprint.paths,
      footprint.documentIds,
      footprint.tagIds,
      footprint,
    )
    const restore = structuredClone(expected)
    restore.documents[0].path = 'proj/a'
    restore.documents[0].updated_at = 2

    expect(restoreDocumentMetadataMutationCASIdempotent(
      db,
      restore,
      expected,
      { ownershipFootprint: footprint },
    )).toEqual({ kind: 'restored-now' })
    expect(restoreDocumentMetadataMutationCASIdempotent(
      db,
      restore,
      expected,
      { ownershipFootprint: footprint },
    )).toEqual({ kind: 'already-restored' })
    expect(metadataSnapshotsExactlyEqual(
      snapshotDocumentMetadataOwnership(
        db,
        footprint.paths,
        footprint.documentIds,
        footprint.tagIds,
        footprint,
      ),
      restore,
    )).toBe(true)
    db.prepare(`UPDATE documents SET summary = 'external' WHERE id = 'a-id'`)
      .run()
    expect(restoreDocumentMetadataMutationCASIdempotent(
      db,
      restore,
      expected,
      { ownershipFootprint: footprint },
    ).kind).toBe('conflict')
    db.close()
  })
})

function emptySnapshot(): SerializedMetadataSnapshot {
  return {
    paths: [],
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

describe('Round-17 durable artifact and schema ownership', () => {
  it('T13 preserves incumbent journal, payload, marker and create-only helper inode/bytes', async () => {
    const targets = [
      path.join(vault, 'journal'),
      path.join(vault, 'payload'),
      path.join(vault, 'direct'),
    ]
    for (const target of targets) {
      await fs.writeFile(target, 'incumbent')
      const before = await fs.lstat(target, { bigint: true })
      const call = target.endsWith('journal')
        ? writeDurableJournal(target, { replacement: true })
        : target.endsWith('payload')
          ? writeDurableRecoveryPayload(target, 'replacement')
          : writeCreateOnlyDurableFile(target, 'replacement')
      await expect(call).rejects.toMatchObject({ code: 'EEXIST' })
      const after = await fs.lstat(target, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(await fs.readFile(target, 'utf8')).toBe('incumbent')
    }

    const gate = path.join(vault, 'gate')
    await fs.mkdir(gate)
    const proof = createFolderMoveGateProof()
    const marker = path.join(gate, proof.markerName)
    await fs.writeFile(marker, 'incumbent')
    const before = await fs.lstat(marker, { bigint: true })
    await expect(writeFolderMoveGateProof(gate, proof))
      .rejects.toMatchObject({ code: 'EEXIST' })
    expect((await fs.lstat(marker, { bigint: true })).ino).toBe(before.ino)
    expect(await fs.readFile(marker, 'utf8')).toBe('incumbent')

    const rewriteTarget = path.join(vault, 'rewrite-owner')
    await writeDurableJournal(rewriteTarget, { phase: 1 })
    await rewriteDurableJournal(rewriteTarget, { phase: 2 })
    expect(JSON.parse(await fs.readFile(rewriteTarget, 'utf8')))
      .toEqual({ phase: 2 })
  })

  it('T14 rejects missing/extra columns, unsafe integers, duplicates, base64 and unstable arrays', () => {
    const base = emptySnapshot()
    base.paths = ['proj/a']
    base.documentIds = ['a-id']
    base.documents = [{
      id: 'a-id',
      path: 'proj/a',
      title: 'a',
      summary: '',
      created_at: 1,
      updated_at: 1,
    }]
    expect(isSerializedMetadataSnapshot(base)).toBe(true)

    const missing = structuredClone(base)
    delete missing.documents[0].path
    expect(isSerializedMetadataSnapshot(missing)).toBe(false)
    const extra = structuredClone(base)
    extra.documents[0].unknown = true
    expect(isSerializedMetadataSnapshot(extra)).toBe(false)
    const unsafe = structuredClone(base)
    unsafe.documents[0].updated_at = Number.MAX_SAFE_INTEGER + 1
    expect(isSerializedMetadataSnapshot(unsafe)).toBe(false)
    const duplicateTag = structuredClone(base)
    duplicateTag.tagIds = [1, 2]
    duplicateTag.tags = [
      { id: 1, name: 'a', normalized_name: 'a' },
      { id: 1, name: 'b', normalized_name: 'b' },
    ]
    expect(isSerializedMetadataSnapshot(duplicateTag)).toBe(false)
    const duplicateRelation = structuredClone(base)
    duplicateRelation.tagIds = [1]
    duplicateRelation.tags = [{ id: 1, name: 'a', normalized_name: 'a' }]
    duplicateRelation.documentTags = [
      { document_id: 'a-id', tag_id: 1 },
      { document_id: 'a-id', tag_id: 1 },
    ]
    expect(isSerializedMetadataSnapshot(duplicateRelation)).toBe(false)
    const badBuffer = structuredClone(base)
    badBuffer.embeddings = [{
      document_id: 'a-id',
      content_hash: '',
      model: '',
      embedding: { __nuvynBuffer: 'AB==' },
      indexed_at: 1,
    }]
    expect(isSerializedMetadataSnapshot(badBuffer)).toBe(false)
    const unstable = structuredClone(base)
    unstable.paths = ['z', 'a']
    expect(isSerializedMetadataSnapshot(unstable)).toBe(false)
    const duplicateMigration = structuredClone(base)
    duplicateMigration.migrations = [{
      path: 'proj/migration',
      document_id: 'a-id',
      original_path: 'proj/migration',
      status: 'legacy',
      source_hash: 'hash',
      error: '',
      updated_at: 1,
      frontmatter_backup: null,
      cleaned_hash: null,
    }, {
      path: 'proj/migration',
      document_id: 'a-id',
      original_path: 'proj/migration',
      status: 'legacy',
      source_hash: 'hash',
      error: '',
      updated_at: 1,
      frontmatter_backup: null,
      cleaned_hash: null,
    }]
    expect(isSerializedMetadataSnapshot(duplicateMigration)).toBe(false)
  })
})

describe('Round-17 source and legacy ownership', () => {
  it('T10/T11/T12 preserves a reused or undeclared empty source/gate directory', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(source)
    const stat = await fs.lstat(source, { bigint: true })
    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'prepared',
      srcRel: 'src',
      destRel: 'dest',
      strategy: 'replayable-move',
      sourceDev: stat.dev.toString(),
      sourceIno: stat.ino.toString(),
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }
    await fs.mkdir(path.join(source, 'external-empty'))
    expect(await inspectFolderMoveSourceInventory(source, journal))
      .toMatchObject({ kind: 'external' })
    await removeDeclaredEmptyDirectories(source, [], {
      removeRoot: true,
      expectedRootGeneration: {
        dev: journal.sourceDev,
        ino: journal.sourceIno,
      },
    })
    expect(await fs.stat(path.join(source, 'external-empty'))).toBeDefined()
  })

  it('T15 quarantines a weak legacy folder journal without filesystem mutation', async () => {
    await fs.mkdir(path.join(vault, 'proj'))
    await fs.writeFile(path.join(vault, 'proj', 'a.md'), '# a\n')
    await fs.writeFile(path.join(vault, 'ref.md'), 'before')
    const sourceStat = await fs.stat(path.join(vault, 'proj'))
    const token = 'abcdef012345'
    const beforePayload = `.proj.nuvyn-ref-before-${token}-0`
    const afterPayload = `.proj.nuvyn-ref-after-${token}-0`
    await writeDurableRecoveryPayload(path.join(vault, beforePayload), 'before')
    await writeDurableRecoveryPayload(path.join(vault, afterPayload), 'after')
    const journalPath = path.join(vault, `.proj.nuvyn-journal-${token}`)
    await writeDurableJournal(journalPath, {
      version: 1,
      op: 'folder-rename-references',
      phase: 'roll-back',
      srcRel: 'proj',
      destRel: 'ren',
      sourceDev: sourceStat.dev,
      sourceIno: sourceStat.ino,
      identities: [{ path: 'proj/a', id: 'a-id' }],
      references: [{
        path: 'ref',
        beforeHash: sha256Hex('before'),
        afterHash: sha256Hex('after'),
        beforePayload,
        afterPayload,
      }],
    })
    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual({
      file: path.basename(journalPath),
      action: 'quarantined',
      detail: 'legacy journal lacks sufficient durable ownership proof',
    })
    expect(second.actions.every(action =>
      action.action === 'quarantined'
      || action.action === 'failed')).toBe(true)
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('before')
    expect(await fs.stat(journalPath)).toBeDefined()
    db.close()
  })
})
