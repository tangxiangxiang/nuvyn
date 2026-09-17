import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { DocumentMetadataError, patchDocumentMetadata } from '../documentMetadata'
import { documentWriteLockWaitersForTesting, withDocumentWriteLock } from '../documentWriteLock'
import { CONTENT_DIR, setContentDir } from '../paths'
import { __resetLinkIndexForTesting, getIndex as getLinkIndex } from '../linkIndex'
import * as git from '../history/git'
import { ensureRepo } from '../history/repo'
import { createVaultFileChanges } from '../../src/composables/vault/context/fileChanges'
import {
  __setTagManagementApplyHooksForTesting,
  __setTagManagementPlannerHookForTesting,
  applyTagOperation,
  buildTagOperationPlan,
  buildTagOperationPlanState,
  isPlanFingerprint,
  listManagedTags,
  parseTagApplyRequest,
  parsePreviewPageRequest,
  parseTagOperation,
  previewTagOperation,
  previewTagOperationPage,
  TagManagementError,
  type TagOperationRequest,
} from '../tagManagement'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(() => {
  __setTagManagementApplyHooksForTesting(null)
  __setTagManagementPlannerHookForTesting(null)
  if (db.open) db.close()
})

function seedTag(id: number, displayName: string, normalizedName = displayName.toLowerCase()): void {
  db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(id, displayName, normalizedName)
}

function seedDocument(
  id: string,
  tagIds: number[] = [],
  options: { title?: string; summary?: string; createdAt?: number; updatedAt?: number } = {},
): void {
  const createdAt = options.createdAt ?? 100
  const updatedAt = options.updatedAt ?? createdAt
  db.prepare(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `${id}/note`, options.title ?? id, options.summary ?? '', createdAt, updatedAt)
  const insert = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) insert.run(id, tagId)
}

function seedBasicGraph(): void {
  seedTag(7, 'Java', 'java')
  seedDocument('b', [7], { title: 'B' })
  seedDocument('a', [7], { title: 'A' })
}

function expectDomainCode(callback: () => unknown, code: string): void {
  try {
    callback()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(TagManagementError)
    expect((error as TagManagementError).code).toBe(code)
  }
}

async function expectAsyncDomainCode(callback: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await callback()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(TagManagementError)
    expect((error as TagManagementError).code).toBe(code)
  }
}

describe('tag management read model', () => {
  it('lists stable IDs, distinct document counts, orphans, and binary identity order', () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(12, 'Orphan', 'orphan')
    seedDocument('doc-a', [7, 9])
    seedDocument('doc-b', [7])

    expect(listManagedTags(db)).toEqual([
      { id: 9, normalizedName: 'backend', displayName: 'Backend', documentCount: 1 },
      { id: 7, normalizedName: 'java', displayName: 'Java', documentCount: 2 },
      { id: 12, normalizedName: 'orphan', displayName: 'Orphan', documentCount: 0 },
    ])
  })
})

describe('tag management planner', () => {
  it('plans normal Rename with source ID preserved and no association delta', () => {
    seedBasicGraph()
    const before = db.prepare('SELECT * FROM tags UNION ALL SELECT * FROM tags').all()
    const plan = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: ' Backend ' })

    expect(plan).toMatchObject({
      operation: { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
      sourceTag: { id: 7, displayName: 'Java', normalizedName: 'java' },
      destinationTag: null,
      survivorTag: { id: 7 },
      displayOnly: false,
      affectedCount: 2,
      associationAdds: 0,
      associationRemoves: 0,
      duplicateCollapses: 0,
      tagCreates: 0,
      tagDeletes: 0,
      allowedToApply: true,
    })
    expect(plan.affectedDocuments.map((document) => document.id)).toEqual(['a', 'b'])
    expect(isPlanFingerprint(plan.planFingerprint)).toBe(true)
    expect(db.prepare('SELECT * FROM tags UNION ALL SELECT * FROM tags').all()).toEqual(before)
  })

  it('distinguishes Display Rename from a same-display no-op', () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])

    const display = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' })
    expect(display).toMatchObject({ displayOnly: true, allowedToApply: true, affectedCount: 1 })
    expect(display.conflictCode).toBeUndefined()

    const noop = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Java' })
    expect(noop).toMatchObject({ displayOnly: false, allowedToApply: false, conflictCode: 'INVALID_OPERATION' })
  })

  it('returns a reviewable Rename destination conflict without planning an implicit Merge', () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('doc', [7])

    const plan = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'backend' })
    expect(plan).toMatchObject({
      allowedToApply: false,
      conflictCode: 'DESTINATION_EXISTS',
      destinationTag: { id: 9, displayName: 'Backend' },
      associationAdds: 0,
      associationRemoves: 0,
      tagDeletes: 0,
    })
  })

  it('plans orphan Rename and Remove with zero affected documents', () => {
    seedTag(7, 'Orphan', 'orphan')
    const rename = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Renamed' })
    const remove = buildTagOperationPlan(db, { kind: 'remove', sourceTagId: 7 })

    expect(rename).toMatchObject({ affectedCount: 0, allowedToApply: true })
    expect(remove).toMatchObject({
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      duplicateCollapses: 0,
      tagDeletes: 1,
      allowedToApply: true,
      warnings: ['DESTRUCTIVE'],
    })
  })

  it('plans Merge with exact source-only adds, overlap collapses, and destination survivor', () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(20, 'Python', 'python')
    seedDocument('source-only', [7])
    seedDocument('overlap', [7, 9])
    seedDocument('destination-only', [9, 20])

    const plan = buildTagOperationPlan(db, { kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    expect(plan).toMatchObject({
      affectedCount: 2,
      associationAdds: 1,
      associationRemoves: 2,
      duplicateCollapses: 1,
      tagDeletes: 1,
      survivorTag: { id: 9, displayName: 'Backend' },
      allowedToApply: true,
    })
    expect(plan.affectedDocuments.map((document) => document.id)).toEqual(['overlap', 'source-only'])
    expect(plan.affectedDocuments.some((document) => document.id === 'destination-only')).toBe(false)
  })

  it('rejects missing Merge rows and self Merge with stable domain codes', () => {
    seedTag(7, 'Java', 'java')
    expectDomainCode(() => buildTagOperationPlan(db, { kind: 'merge', sourceTagId: 7, destinationTagId: 9 }), 'TAG_NOT_FOUND')
    expect(buildTagOperationPlan(db, { kind: 'merge', sourceTagId: 7, destinationTagId: 7 })).toMatchObject({
      allowedToApply: false,
      conflictCode: 'SOURCE_DESTINATION_SAME',
    })
  })

  it('keeps missing source and destination as explicit shared resolution states', () => {
    seedTag(7, 'Java', 'java')

    const missingSource = buildTagOperationPlanState(db, { kind: 'remove', sourceTagId: 9 })
    expect(missingSource.resolution).toEqual({ source: null, destination: null })

    const missingDestination = buildTagOperationPlanState(db, { kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    expect(missingDestination.resolution.source).toMatchObject({ id: 7, normalizedName: 'java' })
    expect(missingDestination.resolution.destination).toBeNull()
  })

  it.each(['created_at', 'updated_at'] as const)('fails closed for an unsafe persisted %s fingerprint value', (field) => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    db.exec(`UPDATE documents SET ${field} = 9223372036854775807 WHERE id = 'doc'`)

    expectDomainCode(
      () => buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }),
      'TAG_IDENTITY_CONFLICT',
    )
  })

  it('accepts the exact JavaScript safe-integer timestamp boundary', () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], {
      createdAt: Number.MAX_SAFE_INTEGER,
      updatedAt: Number.MAX_SAFE_INTEGER,
    })

    expect(buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }).planFingerprint)
      .toMatch(/^[0-9a-f]{64}$/)
  })

  it('adds HIGH_IMPACT only at the stable 1000-document threshold', () => {
    seedTag(7, 'Java', 'java')
    const insertDocument = db.prepare(`
      INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES (?, ?, ?, '', 1, 1)
    `)
    const insertAssociation = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, 7)')
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const id = `doc-${String(i).padStart(4, '0')}`
        insertDocument.run(id, id, id)
        insertAssociation.run(id)
      }
    })()

    const plan = buildTagOperationPlan(db, { kind: 'remove', sourceTagId: 7 })
    expect(plan.affectedCount).toBe(1000)
    expect(plan.sample).toHaveLength(20)
    expect(plan.warnings).toEqual(['DESTRUCTIVE', 'HIGH_IMPACT'])
  })
})

describe('tag management fingerprints and pagination', () => {
  it('fingerprints the relevant graph but ignores unrelated documents and tags', () => {
    seedTag(7, 'Java', 'java')
    seedTag(20, 'Python', 'python')
    seedDocument('affected', [7], { title: 'Before', summary: 'summary' })
    seedDocument('unrelated', [20], { title: 'Other' })
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }

    const initial = buildTagOperationPlan(db, operation)
    db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('Other changed', 'unrelated')
    db.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Python 3', 20)
    expect(buildTagOperationPlan(db, operation).planFingerprint).toBe(initial.planFingerprint)

    db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('After', 'affected')
    expect(buildTagOperationPlan(db, operation).planFingerprint).not.toBe(initial.planFingerprint)

    const afterTitle = buildTagOperationPlan(db, operation)
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(30, 'Extra', 'extra')
    db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('affected', 30)
    expect(buildTagOperationPlan(db, operation).planFingerprint).not.toBe(afterTitle.planFingerprint)
  })

  it('fingerprints destination absence and treats normalized request spellings identically', () => {
    seedTag(7, 'Java', 'java')
    seedDocument('affected', [7])
    const withSpaces = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: ' Backend ' })
    const withoutSpaces = buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    expect(withSpaces.planFingerprint).toBe(withoutSpaces.planFingerprint)

    seedTag(9, 'Backend', 'backend')
    expect(buildTagOperationPlan(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }).planFingerprint)
      .not.toBe(withSpaces.planFingerprint)
  })

  it('excludes Merge destination-only metadata while fingerprinting source graph state', () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('source', [7], { title: 'Source' })
    seedDocument('destination-only', [9], { title: 'Destination before', summary: 'before' })
    const operation: TagOperationRequest = { kind: 'merge', sourceTagId: 7, destinationTagId: 9 }
    const initial = buildTagOperationPlan(db, operation)

    db.prepare('UPDATE documents SET title = ?, summary = ? WHERE id = ?')
      .run('Destination after', 'after', 'destination-only')
    expect(buildTagOperationPlan(db, operation).planFingerprint).toBe(initial.planFingerprint)

    db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('Source after', 'source')
    expect(buildTagOperationPlan(db, operation).planFingerprint).not.toBe(initial.planFingerprint)
  })

  it('keeps Preview read-only, including marker/settings and all tag/document rows', () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const before = {
      tags: db.prepare('SELECT * FROM tags').all(),
      associations: db.prepare('SELECT * FROM document_tags').all(),
      documents: db.prepare('SELECT * FROM documents').all(),
      settings: db.prepare('SELECT * FROM settings').all(),
    }
    previewTagOperation(db, { kind: 'remove', sourceTagId: 7 })
    expect({
      tags: db.prepare('SELECT * FROM tags').all(),
      associations: db.prepare('SELECT * FROM document_tags').all(),
      documents: db.prepare('SELECT * FROM documents').all(),
      settings: db.prepare('SELECT * FROM settings').all(),
    }).toEqual(before)
  })

  it('returns bounded deterministic pages and rejects stale or tampered continuation', () => {
    seedTag(7, 'Java', 'java')
    for (let i = 0; i < 25; i++) seedDocument(`doc-${String(i).padStart(2, '0')}`, [7])
    const operation: TagOperationRequest = { kind: 'remove', sourceTagId: 7 }
    const preview = previewTagOperation(db, operation)
    expect(preview.sample).toHaveLength(20)
    expect(preview.nextAfterDocumentId).toBe('doc-19')

    const page = previewTagOperationPage(db, operation, preview.planFingerprint, preview.nextAfterDocumentId!, 3)
    expect(page.sample.map((document) => document.id)).toEqual(['doc-20', 'doc-21', 'doc-22'])
    expect(page.nextAfterDocumentId).toBe('doc-22')
    expectDomainCode(
      () => previewTagOperationPage(db, operation, preview.planFingerprint, 'unrelated', 3),
      'INVALID_OPERATION',
    )

    db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('Changed', 'doc-20')
    expectDomainCode(
      () => previewTagOperationPage(db, operation, preview.planFingerprint, 'doc-19', 3),
      'PREVIEW_STALE',
    )

    db.prepare('DELETE FROM tags WHERE id = ?').run(7)
    expectDomainCode(
      () => previewTagOperationPage(db, operation, preview.planFingerprint, 'doc-19', 3),
      'PREVIEW_STALE',
    )
  })

  it('classifies shared resolution changes as stale for Merge and Rename continuation', () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('source', [7])

    const mergeOperation: TagOperationRequest = { kind: 'merge', sourceTagId: 7, destinationTagId: 9 }
    const mergePreview = previewTagOperation(db, mergeOperation)
    db.prepare('DELETE FROM tags WHERE id = ?').run(9)
    expectDomainCode(
      () => previewTagOperationPage(db, mergeOperation, mergePreview.planFingerprint, undefined, 1),
      'PREVIEW_STALE',
    )

    const renamePreview = previewTagOperation(db, { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    seedTag(11, 'Backend', 'backend')
    expectDomainCode(
      () => previewTagOperationPage(
        db,
        { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
        renamePreview.planFingerprint,
        undefined,
        1,
      ),
      'PREVIEW_STALE',
    )
  })

  it('keeps a Preview valid when an unrelated orphan tag disappears', () => {
    seedTag(7, 'Java', 'java')
    seedTag(20, 'Unrelated', 'unrelated')
    seedDocument('source', [7])
    const operation: TagOperationRequest = { kind: 'remove', sourceTagId: 7 }
    const preview = previewTagOperation(db, operation)

    db.prepare('DELETE FROM tags WHERE id = ?').run(20)
    expect(previewTagOperationPage(db, operation, preview.planFingerprint, undefined, 1)).toMatchObject({
      planFingerprint: preview.planFingerprint,
      affectedCount: 1,
    })
  })

  it('uses a deferred read transaction snapshot while another WAL connection commits', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-preview-wal-'))
    const databasePath = path.join(directory, 'preview.db')
    const first = new Database(databasePath)
    const second = new Database(databasePath)
    try {
      first.pragma('journal_mode = WAL')
      first.pragma('foreign_keys = ON')
      applyMigrations(first)
      second.pragma('journal_mode = WAL')
      second.pragma('foreign_keys = ON')
      seedTagOn(first, 7, 'Java', 'java')
      seedTagOn(first, 9, 'Backend', 'backend')
      seedDocumentOn(first, 'doc', [7], { title: 'Before' })
      const operation: TagOperationRequest = { kind: 'merge', sourceTagId: 7, destinationTagId: 9 }
      const beforePlan = buildTagOperationPlan(first, operation)
      expect(beforePlan.affectedDocuments[0]?.completeTagRows.map((tag) => tag.id)).toEqual([7])
      __setTagManagementPlannerHookForTesting((stage) => {
        if (stage !== 'after-affected-document-read') return
        second.prepare('UPDATE documents SET title = ? WHERE id = ?').run('After', 'doc')
        second.prepare('UPDATE tags SET name = ? WHERE id = ?').run('JAVA', 7)
        second.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc', 9)
      })

      const preview = previewTagOperation(first, operation)
      expect(preview).toMatchObject({
        sourceTag: { id: 7, displayName: 'Java', normalizedName: 'java' },
        affectedCount: beforePlan.affectedCount,
        associationAdds: beforePlan.associationAdds,
        associationRemoves: beforePlan.associationRemoves,
        duplicateCollapses: beforePlan.duplicateCollapses,
        sample: beforePlan.sample,
        planFingerprint: beforePlan.planFingerprint,
      })
      expect(preview.sample[0]).toMatchObject({ id: 'doc', title: 'Before' })

      __setTagManagementPlannerHookForTesting(null)
      const afterPlan = buildTagOperationPlan(first, operation)
      const afterPreview = previewTagOperation(first, operation)
      expect(afterPlan.sourceTag).toMatchObject({ id: 7, displayName: 'JAVA', normalizedName: 'java' })
      expect(afterPlan.affectedDocuments[0]).toMatchObject({ id: 'doc', title: 'After' })
      expect(afterPlan.affectedDocuments[0]?.completeTagRows.map((tag) => tag.id)).toEqual([7, 9])
      expect(afterPlan).toMatchObject({
        affectedCount: 1,
        associationAdds: 0,
        associationRemoves: 1,
        duplicateCollapses: 1,
      })
      expect(afterPlan.planFingerprint).not.toBe(beforePlan.planFingerprint)
      expect(afterPreview).toMatchObject({
        sample: [{ id: 'doc', title: 'After' }],
        affectedCount: afterPlan.affectedCount,
        associationAdds: afterPlan.associationAdds,
        associationRemoves: afterPlan.associationRemoves,
        duplicateCollapses: afterPlan.duplicateCollapses,
        planFingerprint: afterPlan.planFingerprint,
      })
    } finally {
      __setTagManagementPlannerHookForTesting(null)
      if (second.open) second.close()
      if (first.open) first.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a relevant two-connection association change after Preview without partial mutation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-apply-association-wal-'))
    const databasePath = path.join(directory, 'apply.db')
    const first = new Database(databasePath)
    const second = new Database(databasePath)
    try {
      first.pragma('journal_mode = WAL')
      first.pragma('foreign_keys = ON')
      applyMigrations(first)
      second.pragma('journal_mode = WAL')
      second.pragma('foreign_keys = ON')
      seedTagOn(first, 7, 'Java', 'java')
      seedDocumentOn(first, 'doc', [7], { updatedAt: 10 })
      const operation: TagOperationRequest = { kind: 'remove', sourceTagId: 7 }
      const preview = previewTagOperation(first, operation)
      __setTagManagementApplyHooksForTesting({
        afterDiscovery: () => {
          second.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run('doc', 7)
        },
      })

      await expectAsyncDomainCode(
        () => applyTagOperation(first, operation, preview.planFingerprint),
        'PREVIEW_STALE',
      )
      expect(first.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
        { id: 7, name: 'Java', normalized_name: 'java' },
      ])
      expect(first.prepare('SELECT document_id, tag_id FROM document_tags').all()).toEqual([])
      expect(first.prepare('SELECT updated_at FROM documents WHERE id = ?').get('doc')).toEqual({ updated_at: 10 })
    } finally {
      __setTagManagementApplyHooksForTesting(null)
      if (second.open) second.close()
      if (first.open) first.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes two Apply calls from one Preview across two WAL connections', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-apply-two-connections-'))
    const databasePath = path.join(directory, 'apply.db')
    const first = new Database(databasePath)
    const second = new Database(databasePath)
    try {
      first.pragma('journal_mode = WAL')
      first.pragma('foreign_keys = ON')
      applyMigrations(first)
      second.pragma('journal_mode = WAL')
      second.pragma('foreign_keys = ON')
      seedTagOn(first, 7, 'Java', 'java')
      seedDocumentOn(first, 'doc-a', [7])
      seedDocumentOn(first, 'doc-b', [7])
      const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
      const preview = previewTagOperation(first, operation)

      const outcomes = await Promise.allSettled([
        applyTagOperation(first, operation, preview.planFingerprint),
        applyTagOperation(second, operation, preview.planFingerprint),
      ])
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
      expect(rejected?.status).toBe('rejected')
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'PREVIEW_STALE' })
      expect(first.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
        { id: 7, name: 'Backend', normalized_name: 'backend' },
      ])
      expect(first.prepare('SELECT COUNT(*) AS count FROM document_tags WHERE tag_id = ?').get(7)).toEqual({ count: 2 })
    } finally {
      if (second.open) second.close()
      if (first.open) first.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

describe('tag management input safety and query complexity', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '7', null])(
    'rejects unsafe source ID %p',
    (sourceTagId) => {
      expectDomainCode(() => parseTagOperation({ kind: 'remove', sourceTagId }), 'INVALID_OPERATION')
    },
  )

  it('rejects unknown fields, invalid fingerprints, oversized pages, and unsafe names', () => {
    expectDomainCode(() => parseTagOperation({ kind: 'remove', sourceTagId: 7, clientAffectedDocuments: [] }), 'INVALID_OPERATION')
    expectDomainCode(() => parseTagOperation({ kind: 'rename', sourceTagId: 7, destinationName: 'bad\u0000name' }), 'INVALID_TAG_NAME')
    expectDomainCode(() => parseTagOperation({ kind: 'rename', sourceTagId: 7, destinationName: 'x'.repeat(101) }), 'INVALID_TAG_NAME')
    expectDomainCode(() => parsePreviewPageRequest({ operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint: 'A'.repeat(64) }), 'INVALID_OPERATION')
    expectDomainCode(() => parsePreviewPageRequest({ operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint: 'a'.repeat(64), limit: 101 }), 'INVALID_OPERATION')
  })

  it('keeps planner query shapes constant as the affected set grows', () => {
    seedTag(7, 'Java', 'java')
    for (let i = 0; i < 100; i++) seedDocument(`doc-${i}`, [7])
    const preparedStatements: string[] = []
    const countedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          preparedStatements.push(sql)
          return target.prepare(sql)
        }
      },
    }) as Database.Database
    buildTagOperationPlan(countedDb, { kind: 'remove', sourceTagId: 7 })
    // The path-guarded metadata projection keeps the planner at three
    // bounded statements; query count remains constant rather than scaling
    // with the number of affected documents.
    expect(preparedStatements).toHaveLength(3)
    expect(preparedStatements.some((sql) => sql.includes('IN (?, ?,'))).toBe(false)
  })

})

describe('tag management atomic Apply', () => {
  function databaseSnapshot(): unknown {
    return {
      documents: db.prepare('SELECT * FROM documents ORDER BY id').all(),
      tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
      associations: db.prepare('SELECT * FROM document_tags ORDER BY document_id, tag_id').all(),
    }
  }

  it('applies normal Rename in place, versions each source document once, and rejects duplicate Apply', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('b', [7], { updatedAt: 10 })
    seedDocument('a', [7], { updatedAt: 20 })
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    const beforeIds = db.prepare('SELECT document_id, tag_id FROM document_tags WHERE tag_id = 7 ORDER BY document_id').all()

    const result = await applyTagOperation(db, operation, preview.planFingerprint)
    expect(result).toMatchObject({
      kind: 'rename',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      resultId: expect.any(String),
      sourceTagId: 7,
      destinationTagId: null,
      survivorTagId: 7,
      sourceDeleted: false,
      affectedCount: 2,
      associationAdds: 0,
      associationRemoves: 0,
      duplicateCollapses: 0,
      tagCreates: 0,
      tagDeletes: 0,
      displayOnly: false,
      versionUpdateCount: 2,
      appliedFingerprint: preview.planFingerprint,
    })
    expect(result.operationId).toBe(result.resultId)
    expect(db.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
      { id: 7, name: 'Backend', normalized_name: 'backend' },
    ])
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags WHERE tag_id = 7 ORDER BY document_id').all()).toEqual(beforeIds)
    expect(db.prepare('SELECT id, updated_at FROM documents ORDER BY id').all()).toEqual([
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' }),
    ])
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('a') as { updated_at: number }).updated_at).toBeGreaterThan(20)
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('b') as { updated_at: number }).updated_at).toBeGreaterThan(10)

    await expectAsyncDomainCode(
      () => applyTagOperation(db, operation, preview.planFingerprint),
      'PREVIEW_STALE',
    )
  })

  it('applies Display Rename without changing identity or associations', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], { updatedAt: 100 })
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' }
    const preview = previewTagOperation(db, operation)
    const result = await applyTagOperation(db, operation, preview.planFingerprint)

    expect(result).toMatchObject({ displayOnly: true, sourceTagId: 7, survivorTagId: 7, versionUpdateCount: 1 })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags').all()).toEqual([
      { id: 7, name: 'JAVA', normalized_name: 'java' },
    ])
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags').all()).toEqual([{ document_id: 'doc', tag_id: 7 }])
  })

  it('applies Merge with overlap accounting and leaves destination-only versions unchanged', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(20, 'Python', 'python')
    seedDocument('source-only', [7], { updatedAt: 10 })
    seedDocument('overlap', [7, 9], { updatedAt: 20 })
    seedDocument('destination-only', [9, 20], { updatedAt: 30 })
    const operation: TagOperationRequest = { kind: 'merge', sourceTagId: 7, destinationTagId: 9 }
    const preview = previewTagOperation(db, operation)
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    let result: Awaited<ReturnType<typeof applyTagOperation>>
    try {
      result = await applyTagOperation(db, operation, preview.planFingerprint)
      const events = logSpy.mock.calls.filter((call) => call[0] === '[tag-management-apply]')
      expect(events).toHaveLength(1)
      expect(JSON.parse(String(events[0]?.[1]))).toMatchObject({
        operationId: result.operationId,
        resultId: result.resultId,
        kind: 'merge',
        operation: result.operation,
        sourceTagId: 7,
        destinationTagId: 9,
        survivorTagId: 9,
        sourceDeleted: true,
        affectedCount: 2,
        associationAdds: 1,
        associationRemoves: 2,
        duplicateCollapses: 1,
        tagDeletes: 1,
        displayOnly: false,
        versionUpdateCount: 2,
        appliedFingerprint: preview.planFingerprint,
      })
    } finally {
      logSpy.mockRestore()
    }

    expect(result).toMatchObject({
      kind: 'merge',
      sourceTagId: 7,
      destinationTagId: 9,
      survivorTagId: 9,
      sourceDeleted: true,
      affectedCount: 2,
      associationAdds: 1,
      associationRemoves: 2,
      duplicateCollapses: 1,
      tagDeletes: 1,
      versionUpdateCount: 2,
    })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags ORDER BY id').all()).toEqual([
      { id: 9, name: 'Backend', normalized_name: 'backend' },
      { id: 20, name: 'Python', normalized_name: 'python' },
    ])
    expect(db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY document_id, tag_id').all()).toEqual([
      { document_id: 'destination-only', tag_id: 9 },
      { document_id: 'destination-only', tag_id: 20 },
      { document_id: 'overlap', tag_id: 9 },
      { document_id: 'source-only', tag_id: 9 },
    ])
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('destination-only') as { updated_at: number }).updated_at).toBe(30)
  })

  it('applies orphan Remove without versioning any document', async () => {
    seedTag(7, 'Orphan', 'orphan')
    const operation: TagOperationRequest = { kind: 'remove', sourceTagId: 7 }
    const preview = previewTagOperation(db, operation)
    const before = databaseSnapshot()
    const result = await applyTagOperation(db, operation, preview.planFingerprint)

    expect(result).toMatchObject({
      kind: 'remove',
      sourceTagId: 7,
      survivorTagId: null,
      sourceDeleted: true,
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      tagDeletes: 1,
      versionUpdateCount: 0,
    })
    expect(db.prepare('SELECT * FROM tags').all()).toEqual([])
    expect(db.prepare('SELECT * FROM documents').all()).toEqual((before as { documents: unknown[] }).documents)
  })

  it.each([
    ['after-version-update', { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }],
    ['after-tag-row-mutation', { kind: 'remove', sourceTagId: 7 }],
    ['before-postcondition', { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }],
    ['before-commit', { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }],
  ] as const)('rolls back every row and version after injected %s failure', async (stage, operation) => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], { updatedAt: 100 })
    const preview = previewTagOperation(db, operation)
    const before = databaseSnapshot()
    __setTagManagementApplyHooksForTesting({ failureStage: stage })

    await expectAsyncDomainCode(
      () => applyTagOperation(db, operation, preview.planFingerprint),
      'TRANSACTION_FAILED',
    )
    expect(databaseSnapshot()).toEqual(before)
  })

  it('rolls back Merge after association mutation', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('source', [7], { updatedAt: 100 })
    seedDocument('overlap', [7, 9], { updatedAt: 200 })
    const operation: TagOperationRequest = { kind: 'merge', sourceTagId: 7, destinationTagId: 9 }
    const preview = previewTagOperation(db, operation)
    const before = databaseSnapshot()
    __setTagManagementApplyHooksForTesting({ failureStage: 'after-association-mutation' })

    await expectAsyncDomainCode(
      () => applyTagOperation(db, operation, preview.planFingerprint),
      'TRANSACTION_FAILED',
    )
    expect(databaseSnapshot()).toEqual(before)
  })

  it('rolls back when a controlled postcondition mismatch is introduced', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], { updatedAt: 100 })
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    const before = databaseSnapshot()
    __setTagManagementApplyHooksForTesting({
      beforePostcondition: (database) => {
        database.prepare('UPDATE tags SET name = ? WHERE id = ?').run('corrupted', 7)
      },
    })
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expectAsyncDomainCode(
        () => applyTagOperation(db, operation, preview.planFingerprint),
        'TRANSACTION_FAILED',
      )
      expect(databaseSnapshot()).toEqual(before)
      expect(logSpy.mock.calls.filter((call) => call[0] === '[tag-management-apply]')).toHaveLength(0)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('returns PREVIEW_STALE before mutation when discovery changes a destination conflict', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    __setTagManagementApplyHooksForTesting({
      afterDiscovery: () => seedTag(9, 'Backend', 'backend'),
    })

    await expectAsyncDomainCode(
      () => applyTagOperation(db, operation, preview.planFingerprint),
      'PREVIEW_STALE',
    )
    expect(db.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get()).toEqual({ name: 'Java', normalized_name: 'java' })
  })

  it('rejects a relevant two-connection change after path discovery before the IMMEDIATE transaction', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-apply-wal-'))
    const databasePath = path.join(directory, 'apply.db')
    const first = new Database(databasePath)
    const second = new Database(databasePath)
    try {
      first.pragma('journal_mode = WAL')
      first.pragma('foreign_keys = ON')
      applyMigrations(first)
      second.pragma('journal_mode = WAL')
      second.pragma('foreign_keys = ON')
      seedTagOn(first, 7, 'Java', 'java')
      seedDocumentOn(first, 'doc', [7], { title: 'Before', updatedAt: 10 })
      const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
      const preview = previewTagOperation(first, operation)
      __setTagManagementApplyHooksForTesting({
        afterLocks: () => second.prepare('UPDATE documents SET title = ? WHERE id = ?').run('After', 'doc'),
      })

      await expectAsyncDomainCode(
        () => applyTagOperation(first, operation, preview.planFingerprint),
        'PREVIEW_STALE',
      )
      expect(first.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get()).toEqual({ name: 'Java', normalized_name: 'java' })
      expect(first.prepare('SELECT title FROM documents WHERE id = ?').get('doc')).toEqual({ title: 'After' })
    } finally {
      __setTagManagementApplyHooksForTesting(null)
      if (second.open) second.close()
      if (first.open) first.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rechecks the fingerprint after locks and before any mutation SQL', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    __setTagManagementApplyHooksForTesting({
      afterLocks: () => db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('changed', 'doc'),
    })
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await expectAsyncDomainCode(
        () => applyTagOperation(db, operation, preview.planFingerprint),
        'PREVIEW_STALE',
      )
      expect(db.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get()).toEqual({ name: 'Java', normalized_name: 'java' })
      expect(logSpy.mock.calls.filter((call) => call[0] === '[tag-management-apply]')).toHaveLength(0)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('serializes two Apply calls from one Preview into one commit and one stale rejection', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('a', [7])
    seedDocument('b', [7])
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    const outcomes = await Promise.allSettled([
      applyTagOperation(db, operation, preview.planFingerprint),
      applyTagOperation(db, operation, preview.planFingerprint),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'PREVIEW_STALE' })
    expect(db.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get()).toEqual({ name: 'Backend', normalized_name: 'backend' })
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('a') as { updated_at: number }).updated_at).toBeGreaterThan(100)
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('b') as { updated_at: number }).updated_at).toBeGreaterThan(100)
  })

  it('waits for an existing document writer lock before locked fingerprint recomputation', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    let releaseWriter!: () => void
    let markWriterStarted!: () => void
    const writerStarted = new Promise<void>((resolve) => { markWriterStarted = resolve })
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })
    const writer = withDocumentWriteLock('doc/note', async () => {
      markWriterStarted()
      await writerGate
    })
    await writerStarted

    const applyPromise = applyTagOperation(db, operation, preview.planFingerprint)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(documentWriteLockWaitersForTesting('doc/note')).toBeGreaterThan(0)
    db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('writer changed', 'doc')
    releaseWriter()
    await writer
    await expectAsyncDomainCode(() => applyPromise, 'PREVIEW_STALE')
  })

  it('rejects a stale explicit tag writer after Apply while title and summary writes preserve the new association', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], { updatedAt: 100 })
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const fullPlan = buildTagOperationPlan(db, operation)
    const preview = previewTagOperation(db, operation)
    const staleVersion = fullPlan.affectedDocuments[0]?.updatedAt
    expect(staleVersion).toBe(100)
    const result = await applyTagOperation(db, operation, preview.planFingerprint)

    try {
      patchDocumentMetadata(db, {
        path: 'doc/note',
        changes: [{ field: 'tags', values: ['Java'] }],
        expectedUpdatedAt: staleVersion,
      })
      throw new Error('expected stale metadata version')
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentMetadataError)
      expect((error as DocumentMetadataError).code).toBe('METADATA_VERSION_CONFLICT')
    }

    patchDocumentMetadata(db, { path: 'doc/note', changes: [{ field: 'title', value: 'New title' }] })
    patchDocumentMetadata(db, { path: 'doc/note', changes: [{ field: 'summary', value: 'New summary' }] })
    expect(db.prepare(`
      SELECT t.name
      FROM document_tags dt
      JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ?
    `).get('doc')).toEqual({ name: 'Backend' })
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('doc') as { updated_at: number }).updated_at)
      .toBeGreaterThan(result.commitTimestamp)
  })

  it('uses one commit candidate with strict monotonic increments for equal and future versions', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('below', [7], { updatedAt: 999 })
    seedDocument('equal', [7], { updatedAt: 1000 })
    seedDocument('future', [7], { updatedAt: 1001 })
    const operation: TagOperationRequest = { kind: 'remove', sourceTagId: 7 }
    const preview = previewTagOperation(db, operation)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const result = await applyTagOperation(db, operation, preview.planFingerprint)
      expect(result.commitTimestamp).toBe(1000)
    } finally {
      clock.mockRestore()
    }
    expect(db.prepare('SELECT id, updated_at FROM documents ORDER BY id').all()).toEqual([
      { id: 'below', updated_at: 1000 },
      { id: 'equal', updated_at: 1001 },
      { id: 'future', updated_at: 1002 },
    ])
  })

  it('keeps Markdown bytes, mtime, fileChanges, link index, Git, settings, and the success log outside Apply mutation scope', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-apply-boundary-'))
    const file = path.join(directory, 'doc', 'note.md')
    const otherFile = path.join(directory, 'other.md')
    const originalContentDir = CONTENT_DIR
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# unchanged\nsee [[other]]\n', 'utf8')
    await fs.writeFile(otherFile, '# other\n', 'utf8')
    const beforeBytes = await fs.readFile(file)
    const beforeMtime = (await fs.stat(file)).mtimeMs
    const beforeSettings = db.prepare('SELECT * FROM settings ORDER BY key').all()
    const fileChanges = createVaultFileChanges()
    fileChanges.publish({ path: 'doc/note', kind: 'write', newMtime: beforeMtime, newRaw: '# unchanged\nsee [[other]]\n' })
    const beforeFileChanges = fileChanges.events.value.map((event) => ({ ...event }))
    setContentDir(directory)
    __resetLinkIndexForTesting()
    const beforeLinkIndex = (await getLinkIndex()).snapshot()
    await ensureRepo(directory)
    await git.run(directory, ['config', 'user.name', 'Tags Apply Test'])
    await git.run(directory, ['config', 'user.email', 'tags-apply@example.test'])
    await git.run(directory, ['add', '--', 'doc/note.md', 'other.md'])
    const committed = await git.run(directory, ['commit', '-m', 'boundary seed'])
    expect(committed.status).toBe(0)
    const beforeGitHead = (await git.run(directory, ['rev-parse', 'HEAD'])).stdout.trim()
    const beforeGitStatus = await git.status(directory)
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const result = await applyTagOperation(db, operation, preview.planFingerprint)
      const logCall = logSpy.mock.calls.find((call) => call[0] === '[tag-management-apply]')
      expect(logCall?.[1]).toBeTypeOf('string')
      expect(logSpy.mock.calls.filter((call) => call[0] === '[tag-management-apply]')).toHaveLength(1)
      expect(JSON.parse(String(logCall?.[1]))).toEqual({
        operationId: result.operationId,
        resultId: result.resultId,
        kind: result.kind,
        operation: result.operation,
        sourceTagId: result.sourceTagId,
        destinationTagId: result.destinationTagId,
        survivorTagId: result.survivorTagId,
        sourceTag: result.sourceTag,
        destinationTag: result.destinationTag,
        survivorTag: result.survivorTag,
        sourceDisplayName: result.sourceDisplayName,
        sourceNormalizedName: result.sourceNormalizedName,
        destinationDisplayName: result.destinationDisplayName,
        destinationNormalizedName: result.destinationNormalizedName,
        survivorDisplayName: result.survivorDisplayName,
        survivorNormalizedName: result.survivorNormalizedName,
        sourceDeleted: result.sourceDeleted,
        affectedCount: result.affectedCount,
        associationAdds: result.associationAdds,
        associationRemoves: result.associationRemoves,
        duplicateCollapses: result.duplicateCollapses,
        tagCreates: result.tagCreates,
        tagDeletes: result.tagDeletes,
        displayOnly: result.displayOnly,
        versionUpdateCount: result.versionUpdateCount,
        commitTimestamp: result.commitTimestamp,
        appliedFingerprint: result.appliedFingerprint,
      })
      expect(fileChanges.events.value).toEqual(beforeFileChanges)
      expect((await getLinkIndex()).snapshot()).toEqual(beforeLinkIndex)
      expect((await git.run(directory, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(beforeGitHead)
      expect(await git.status(directory)).toEqual(beforeGitStatus)
      expect(await fs.readFile(file)).toEqual(beforeBytes)
      expect((await fs.stat(file)).mtimeMs).toBe(beforeMtime)
      expect(db.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(beforeSettings)
    } finally {
      logSpy.mockRestore()
      setContentDir(originalContentDir)
      __resetLinkIndexForTesting()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('fails before mutation when an affected document cannot advance its version', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], { updatedAt: Number.MAX_SAFE_INTEGER })
    const operation: TagOperationRequest = { kind: 'remove', sourceTagId: 7 }
    const preview = previewTagOperation(db, operation)
    const before = databaseSnapshot()

    await expectAsyncDomainCode(
      () => applyTagOperation(db, operation, preview.planFingerprint),
      'TRANSACTION_FAILED',
    )
    expect(databaseSnapshot()).toEqual(before)
  })

  it('returns the current reviewed conflict without reaching mutation SQL', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('doc', [7])
    const operation: TagOperationRequest = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }
    const preview = previewTagOperation(db, operation)
    expect(preview.allowedToApply).toBe(false)

    await expectAsyncDomainCode(
      () => applyTagOperation(db, operation, preview.planFingerprint),
      'DESTINATION_EXISTS',
    )
    expect(db.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get()).toEqual({ name: 'Java', normalized_name: 'java' })
  })

  it('requires a current fingerprint and accepts only the exact Apply body', () => {
    expectDomainCode(
      () => parseTagApplyRequest({ operation: { kind: 'remove', sourceTagId: 7 } }),
      'PREVIEW_REQUIRED',
    )
    expectDomainCode(
      () => parseTagApplyRequest({ operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint: 'A'.repeat(64) }),
      'PREVIEW_REQUIRED',
    )
    expectDomainCode(
      () => parseTagApplyRequest({ operation: { kind: 'remove', sourceTagId: 7 }, planFingerprint: 'a'.repeat(64), sample: [] }),
      'INVALID_OPERATION',
    )
  })
})

function seedTagOn(database: Database.Database, id: number, displayName: string, normalizedName: string): void {
  database.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(id, displayName, normalizedName)
}

function seedDocumentOn(
  database: Database.Database,
  id: string,
  tagIds: number[],
  options: { title?: string; summary?: string; createdAt?: number; updatedAt?: number } = {},
): void {
  const createdAt = options.createdAt ?? 100
  const updatedAt = options.updatedAt ?? createdAt
  database.prepare(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `${id}/note`, options.title ?? id, options.summary ?? '', createdAt, updatedAt)
  const insert = database.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) insert.run(id, tagId)
}
