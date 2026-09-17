import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { applyMigrations } from '../db'
import {
  __setTagManagementApplyHooksForTesting,
  applyTagOperation,
  previewTagOperation,
  TagManagementError,
  type TagManagementApplyFailureStage,
  type TagOperationRequest,
} from '../tagManagement'
import {
  __setTagUndoApplyHooksForTesting,
  applyTagUndo,
  buildTagUndoPlan,
  getTagUndoAvailability,
  parseTagUndoApplyRequest,
  previewTagUndo,
  previewTagUndoPage,
  type TagUndoApplyFailureStage,
  TagUndoPlannerError,
} from '../tagUndo'
import {
  initializeTagUndoFoundationHealth,
  resetTagUndoFoundationHealthForTesting,
} from '../tagUndoHealth'

let db: Database.Database

const TSX_ESM_LOADER = import.meta.resolve('tsx/esm')
const TAG_UNDO_WAL_WORKER = path.join(import.meta.dirname, 'fixtures', 'tag-undo-wal-worker.ts')
const TAG_UNDO_APPLY_WAL_WORKER = path.join(import.meta.dirname, 'fixtures', 'tag-undo-apply-wal-worker.ts')

type WalWorkerReady = {
  workerName: string
  pid: number
  connectionId: string
  journalMode: string
  databaseGeneration: string
}

type WalWorkerResult = {
  ok: boolean
  workerName: string
  pid: number
  connectionId?: string
  journalMode?: string
  databaseGeneration?: string
  result?: {
    operationId: string
    resultId: string
  }
  error?: {
    code?: string
    message?: string
  }
}

type WalWorkerHandle = {
  child: ChildProcess
  ready: Promise<WalWorkerReady>
  result: Promise<WalWorkerResult>
  close: Promise<void>
}

type UndoApplyWalWorkerReady = WalWorkerReady

type UndoApplyWalWorkerResult = {
  ok: boolean
  workerName: string
  pid: number
  connectionId?: string
  journalMode?: string
  databaseGeneration?: string
  result?: {
    undoOperationId: string
    undoResultId: string
    recordId: string
    originalOperationId: string
    originalResultId: string
    kind: 'rename' | 'merge' | 'remove'
    affectedCount: number
    associationAdds: number
    associationRemoves: number
    versionUpdateCount: number
  }
  error?: {
    code?: string
    message?: string
  }
}

type UndoApplyWalWorkerHandle = {
  child: ChildProcess
  ready: Promise<UndoApplyWalWorkerReady>
  result: Promise<UndoApplyWalWorkerResult>
  close: Promise<void>
}

function spawnWalWorker(
  databasePath: string,
  operation: TagOperationRequest,
  planFingerprint: string,
  workerName: string,
): WalWorkerHandle {
  const child = spawn(process.execPath, ['--import', TSX_ESM_LOADER, TAG_UNDO_WAL_WORKER], {
    env: {
      ...process.env,
      NUVYN_TAG_WAL_DB: databasePath,
      NUVYN_TAG_WAL_OPERATION: JSON.stringify(operation),
      NUVYN_TAG_WAL_FINGERPRINT: planFingerprint,
      NUVYN_TAG_WAL_WORKER: workerName,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lineReader = createInterface({ input: child.stdout! })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString()
  })

  let readyPayload: WalWorkerReady | undefined
  let resultPayload: WalWorkerResult | undefined
  let resolveReady!: (value: WalWorkerReady) => void
  let rejectReady!: (error: Error) => void
  let resolveResult!: (value: WalWorkerResult) => void
  let rejectResult!: (error: Error) => void
  let resolveClose!: () => void
  const ready = new Promise<WalWorkerReady>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const result = new Promise<WalWorkerResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const close = new Promise<void>((resolve) => {
    resolveClose = resolve
  })

  lineReader.on('line', (line) => {
    try {
      if (line.startsWith('READY:')) {
        readyPayload = JSON.parse(line.slice('READY:'.length)) as WalWorkerReady
        resolveReady(readyPayload)
      } else if (line.startsWith('RESULT:')) {
        resultPayload = JSON.parse(line.slice('RESULT:'.length)) as WalWorkerResult
        resolveResult(resultPayload)
      }
    } catch (error) {
      const parsedError = error instanceof Error ? error : new Error(String(error))
      if (!readyPayload) rejectReady(parsedError)
      if (!resultPayload) rejectResult(parsedError)
    }
  })

  child.once('error', (error) => {
    if (!readyPayload) rejectReady(error)
    if (!resultPayload) rejectResult(error)
    resolveClose()
  })
  child.once('close', (code, signal) => {
    lineReader.close()
    if (!readyPayload) {
      rejectReady(new Error(`${workerName} exited before WAL barrier: code=${code} signal=${signal} stderr=${stderr}`))
    }
    if (!resultPayload) {
      rejectResult(new Error(`${workerName} exited without result: code=${code} signal=${signal} stderr=${stderr}`))
    }
    resolveClose()
  })

  return { child, ready, result, close }
}

function spawnUndoApplyWalWorker(
  databasePath: string,
  reviewed: { recordId: string; undoFingerprint: string },
  workerName: string,
): UndoApplyWalWorkerHandle {
  const child = spawn(process.execPath, ['--import', TSX_ESM_LOADER, TAG_UNDO_APPLY_WAL_WORKER], {
    env: {
      ...process.env,
      NUVYN_TAG_UNDO_WAL_DB: databasePath,
      NUVYN_TAG_UNDO_WAL_RECORD_ID: reviewed.recordId,
      NUVYN_TAG_UNDO_WAL_FINGERPRINT: reviewed.undoFingerprint,
      NUVYN_TAG_UNDO_WAL_WORKER: workerName,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lineReader = createInterface({ input: child.stdout! })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString()
  })

  let readyPayload: UndoApplyWalWorkerReady | undefined
  let resultPayload: UndoApplyWalWorkerResult | undefined
  let resolveReady!: (value: UndoApplyWalWorkerReady) => void
  let rejectReady!: (error: Error) => void
  let resolveResult!: (value: UndoApplyWalWorkerResult) => void
  let rejectResult!: (error: Error) => void
  let resolveClose!: () => void
  const ready = new Promise<UndoApplyWalWorkerReady>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const result = new Promise<UndoApplyWalWorkerResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const close = new Promise<void>((resolve) => {
    resolveClose = resolve
  })

  lineReader.on('line', (line) => {
    try {
      if (line.startsWith('READY:')) {
        readyPayload = JSON.parse(line.slice('READY:'.length)) as UndoApplyWalWorkerReady
        resolveReady(readyPayload)
      } else if (line.startsWith('RESULT:')) {
        resultPayload = JSON.parse(line.slice('RESULT:'.length)) as UndoApplyWalWorkerResult
        resolveResult(resultPayload)
      }
    } catch (error) {
      const parsedError = error instanceof Error ? error : new Error(String(error))
      if (!readyPayload) rejectReady(parsedError)
      if (!resultPayload) rejectResult(parsedError)
    }
  })

  child.once('error', (error) => {
    if (!readyPayload) rejectReady(error)
    if (!resultPayload) rejectResult(error)
    resolveClose()
  })
  child.once('close', (code, signal) => {
    lineReader.close()
    if (!readyPayload) {
      rejectReady(new Error(`${workerName} exited before Undo WAL barrier: code=${code} signal=${signal} stderr=${stderr}`))
    }
    if (!resultPayload) {
      rejectResult(new Error(`${workerName} exited without Undo result: code=${code} signal=${signal} stderr=${stderr}`))
    }
    resolveClose()
  })

  return { child, ready, result, close }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(() => {
  __setTagManagementApplyHooksForTesting(null)
  __setTagUndoApplyHooksForTesting(null)
  resetTagUndoFoundationHealthForTesting(db)
  if (db.open) db.close()
})

function seedTag(id: number, name: string, normalizedName = name.toLowerCase()): void {
  db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(id, name, normalizedName)
}

function seedDocument(id: string, tagIds: number[], updatedAt = 100): void {
  db.prepare(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES (?, ?, ?, '', 1, ?)
  `).run(id, `${id}/note`, id, updatedAt)
  const insert = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) insert.run(id, tagId)
}

async function apply(operation: TagOperationRequest) {
  const preview = previewTagOperation(db, operation)
  return applyTagOperation(db, operation, preview.planFingerprint)
}

function reviewedUndoInput(): { recordId: string; undoFingerprint: string } {
  const preview = previewTagUndo(db)
  return {
    recordId: preview.recordId!,
    undoFingerprint: preview.undoFingerprint!,
  }
}

function parent(): Record<string, unknown> {
  return db.prepare('SELECT * FROM tag_undo_records').get() as Record<string, unknown>
}

function state(): Record<string, unknown> {
  return db.prepare('SELECT * FROM tag_undo_state').get() as Record<string, unknown>
}

function deltas(): Record<string, unknown>[] {
  return db.prepare(`
    SELECT effect, association_id, document_id, tag_id
    FROM tag_undo_association_deltas
    ORDER BY effect, document_id, association_id
  `).all() as Record<string, unknown>[]
}

function durableSnapshot(): Record<string, unknown> {
  return {
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all(),
    documents: db.prepare('SELECT * FROM documents ORDER BY id').all(),
    documentTags: db.prepare('SELECT * FROM document_tags ORDER BY document_id, tag_id').all(),
    records: db.prepare('SELECT * FROM tag_undo_records ORDER BY record_id').all(),
    deltas: db.prepare('SELECT * FROM tag_undo_association_deltas ORDER BY record_id, effect, association_id').all(),
    undoState: db.prepare('SELECT * FROM tag_undo_state').all(),
  }
}

function undoApplyTempTables(): string[] {
  return (db.prepare(`
    SELECT name
    FROM sqlite_temp_master
    WHERE type = 'table'
      AND name LIKE 'tag_undo_apply_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name)
}

function expectTagManagementError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(TagManagementError)
  expect((error as TagManagementError).code).toBe(code)
}

describe('T2.1-1 ordinary Apply durable records', () => {
  it('records identity Rename with canonical fields and no association children', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    seedDocument('doc-b', [7])
    const beforeAssociations = db.prepare(`
      SELECT document_id, association_id
      FROM document_tags
      WHERE tag_id = 7
      ORDER BY document_id
    `).all()

    const result = await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const record = parent()
    expect(record).toMatchObject({
      original_operation_id: result.operationId,
      original_result_id: result.resultId,
      kind: 'rename',
      display_only: 0,
      identity_contract_version: 'tag-identity-v1',
      record_contract_version: 'tag-undo-record-v1',
      operation_json: JSON.stringify({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }),
      source_tag_id: 7,
      source_before_name: 'Java',
      source_before_normalized_name: 'java',
      source_after_exists: 1,
      source_after_name: 'Backend',
      source_after_normalized_name: 'backend',
      destination_tag_id: null,
      destination_before_name: null,
      destination_before_normalized_name: null,
      destination_after_name: null,
      destination_after_normalized_name: null,
      lifecycle: 'latest',
      terminal_code: null,
      undo_operation_id: null,
      undo_result_id: null,
      consumed_at: null,
      association_remove_count: 0,
      association_add_count: 0,
      version_update_count: 2,
    })
    expect(record.record_id).toBe((state() as { current_record_id: string }).current_record_id)
    expect(deltas()).toEqual([])
    expect(db.prepare(`
      SELECT document_id, association_id
      FROM document_tags
      WHERE tag_id = 7
      ORDER BY document_id
    `).all()).toEqual(beforeAssociations)
    expect((state() as { last_superseded_record_id: string | null }).last_superseded_record_id).toBeNull()
  })

  it('records Display Rename without changing association identities', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const before = db.prepare('SELECT association_id FROM document_tags WHERE document_id = ?').get('doc')

    const result = await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' })
    expect(parent()).toMatchObject({
      original_operation_id: result.operationId,
      kind: 'rename',
      display_only: 1,
      source_after_exists: 1,
      source_after_name: 'JAVA',
      source_after_normalized_name: 'java',
      destination_tag_id: null,
      association_remove_count: 0,
      association_add_count: 0,
      version_update_count: 1,
      operation_json: JSON.stringify({ kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' }),
    })
    expect(deltas()).toEqual([])
    expect(db.prepare('SELECT association_id FROM document_tags WHERE document_id = ?').get('doc')).toEqual(before)
  })

  it('records Merge source-only and overlap provenance using actual association IDs', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(20, 'Python', 'python')
    seedDocument('source-only', [7])
    seedDocument('overlap', [7, 9])
    seedDocument('destination-only', [9, 20])

    const before = db.prepare(`
      SELECT document_id, tag_id, association_id
      FROM document_tags
      ORDER BY document_id, tag_id
    `).all() as Array<{ document_id: string; tag_id: number; association_id: number }>
    const sourceOnlySource = before.find((row) => row.document_id === 'source-only' && row.tag_id === 7)!
    const overlapSource = before.find((row) => row.document_id === 'overlap' && row.tag_id === 7)!
    const overlapDestination = before.find((row) => row.document_id === 'overlap' && row.tag_id === 9)!
    const destinationOnly = before.find((row) => row.document_id === 'destination-only' && row.tag_id === 9)!

    const result = await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    expect(parent()).toMatchObject({
      original_operation_id: result.operationId,
      kind: 'merge',
      display_only: 0,
      source_after_exists: 0,
      destination_tag_id: 9,
      destination_before_name: 'Backend',
      destination_before_normalized_name: 'backend',
      destination_after_name: 'Backend',
      destination_after_normalized_name: 'backend',
      association_remove_count: 2,
      association_add_count: 1,
      version_update_count: 2,
      operation_json: JSON.stringify({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 }),
    })
    expect(deltas()).toEqual([
      {
        effect: 'created-destination',
        association_id: expect.any(Number),
        document_id: 'source-only',
        tag_id: 9,
      },
      {
        effect: 'removed-source',
        association_id: overlapSource.association_id,
        document_id: 'overlap',
        tag_id: 7,
      },
      {
        effect: 'removed-source',
        association_id: sourceOnlySource.association_id,
        document_id: 'source-only',
        tag_id: 7,
      },
    ])
    const created = deltas().find((row) => row.effect === 'created-destination')!.association_id
    expect(created).not.toBe(overlapDestination.association_id)
    expect(created).not.toBe(destinationOnly.association_id)
    expect(db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'overlap' AND tag_id = 9
    `).get()).toEqual({ association_id: overlapDestination.association_id })
    expect(db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'destination-only' AND tag_id = 9
    `).get()).toEqual({ association_id: destinationOnly.association_id })
  })

  it('records Remove associations and permits an orphan Remove', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    seedDocument('doc-b', [7])
    const before = db.prepare(`
      SELECT association_id, document_id
      FROM document_tags
      WHERE tag_id = 7
      ORDER BY document_id
    `).all()

    const result = await apply({ kind: 'remove', sourceTagId: 7 })
    expect(parent()).toMatchObject({
      original_operation_id: result.operationId,
      kind: 'remove',
      display_only: 0,
      source_before_name: 'Java',
      source_before_normalized_name: 'java',
      source_after_exists: 0,
      source_after_name: null,
      source_after_normalized_name: null,
      destination_tag_id: null,
      association_remove_count: 2,
      association_add_count: 0,
      version_update_count: 2,
      operation_json: JSON.stringify({ kind: 'remove', sourceTagId: 7 }),
    })
    expect(deltas()).toEqual(before.map((row: any) => ({
      effect: 'removed-source',
      association_id: row.association_id,
      document_id: row.document_id,
      tag_id: 7,
    })))

    seedTag(20, 'Orphan', 'orphan')
    const orphanResult = await apply({ kind: 'remove', sourceTagId: 20 })
    const orphanRecord = parent()
    expect(orphanRecord).toMatchObject({
      original_operation_id: orphanResult.operationId,
      kind: 'remove',
      association_remove_count: 0,
      association_add_count: 0,
      version_update_count: 0,
    })
    expect(deltas()).toEqual([])
    expect((state() as { last_superseded_record_id: string | null }).last_superseded_record_id)
      .toBeTruthy()
  })

  it('supersedes one target with the next and deletes the previous heavy record', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const first = parent().record_id as string
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Kotlin' })
    const second = parent().record_id as string

    expect(second).not.toBe(first)
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT record_id FROM tag_undo_records').get()).toEqual({ record_id: second })
    expect(state()).toMatchObject({ current_record_id: second, last_superseded_record_id: first })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get()).toEqual({ count: 0 })
  })

  it('keeps the existing target and graph unchanged when a second Apply fails', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const before = durableSnapshot()
    __setTagManagementApplyHooksForTesting({ failureStage: 'parent-insert' })

    await expect(apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Kotlin' })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
    })
    expect(durableSnapshot()).toEqual(before)
  })
})

describe('T2.1-1 no-record-no-commit failure matrix', () => {
  const simpleStages: TagManagementApplyFailureStage[] = [
    'parent-insert',
    'after-version-update',
    'after-tag-row-mutation',
    'state-current-record',
    'state-last-superseded',
    'final-postcondition',
  ]

  it.each(simpleStages)('rolls back a Rename at %s', async (stage) => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const before = durableSnapshot()
    __setTagManagementApplyHooksForTesting({ failureStage: stage })

    await expect(apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
    })
    expect(durableSnapshot()).toEqual(before)
  })

  it('rolls back removed-source child capture and post-association failures', async () => {
    for (const stage of ['removed-source-capture', 'after-association-mutation'] as const) {
      db.exec('DELETE FROM documents; DELETE FROM tags;')
      seedTag(7, 'Java', 'java')
      seedDocument('doc', [7])
      const before = durableSnapshot()
      __setTagManagementApplyHooksForTesting({ failureStage: stage })

      await expect(apply({ kind: 'remove', sourceTagId: 7 })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
      expect(durableSnapshot()).toEqual(before)
      __setTagManagementApplyHooksForTesting(null)
    }
  })

  it('rolls back Merge staging and created-destination capture failures', async () => {
    for (const stage of ['merge-source-staging', 'created-destination-capture'] as const) {
      db.exec('DELETE FROM documents; DELETE FROM tags;')
      seedTag(7, 'Java', 'java')
      seedTag(9, 'Backend', 'backend')
      seedDocument('doc', [7])
      const before = durableSnapshot()
      __setTagManagementApplyHooksForTesting({ failureStage: stage })

      await expect(apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 }))
        .rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
      expect(durableSnapshot()).toEqual(before)
      __setTagManagementApplyHooksForTesting(null)
    }
  })

  it('rolls back old-target deletion after pointer transition', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const before = durableSnapshot()
    __setTagManagementApplyHooksForTesting({ failureStage: 'old-target-delete' })

    await expect(apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Kotlin' }))
      .rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
    expect(durableSnapshot()).toEqual(before)
  })
})

describe('T2.1-1 health and compatibility gates', () => {
  it('fails closed before mutation when reversible-record health is unhealthy', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    db.prepare('UPDATE tag_undo_state SET database_generation = ?').run('broken-generation')
    const before = durableSnapshot()

    await expect(apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }))
      .rejects.toMatchObject({ code: 'TAG_MANAGEMENT_UNAVAILABLE' })
    expect(durableSnapshot()).toEqual(before)
  })

  it('records the unchanged old-client Apply shape entirely server-side', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const operation = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' } as const
    const preview = previewTagOperation(db, operation)
    const result = await applyTagOperation(db, operation, preview.planFingerprint)

    expect(Object.keys(result)).not.toContain('recordId')
    expect(db.prepare('SELECT original_operation_id, original_result_id FROM tag_undo_records').get())
      .toEqual({ original_operation_id: result.operationId, original_result_id: result.resultId })
  })

  it('rejects a duplicate reviewed Apply as stale without creating another record', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    const operation = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' } as const
    const preview = previewTagOperation(db, operation)
    await applyTagOperation(db, operation, preview.planFingerprint)

    try {
      await applyTagOperation(db, operation, preview.planFingerprint)
      throw new Error('expected stale duplicate Apply')
    } catch (error) {
      expectTagManagementError(error, 'PREVIEW_STALE')
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 1 })
  })

  it('serializes concurrent same-preview Apply into one durable current record', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    seedDocument('doc-b', [7])
    const operation = { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' } as const
    const preview = previewTagOperation(db, operation)
    const outcomes = await Promise.allSettled([
      applyTagOperation(db, operation, preview.planFingerprint),
      applyTagOperation(db, operation, preview.planFingerprint),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => {
      return outcome.reason
    })).toEqual([expect.objectContaining({ code: 'PREVIEW_STALE' })])
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get()).toEqual({ count: 0 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('serializes a real two-process WAL Apply race with one winner and one stale loser', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-undo-wal-'))
    const databasePath = path.join(temporaryRoot, 'nuvyn.db')
    let setupConnection: Database.Database | null = null
    let gateConnection: Database.Database | null = null
    let thirdConnection: Database.Database | null = null
    const workers: WalWorkerHandle[] = []

    try {
      setupConnection = new Database(databasePath)
      setupConnection.pragma('foreign_keys = ON')
      expect(String(setupConnection.pragma('journal_mode = WAL', { simple: true })).toLowerCase()).toBe('wal')
      applyMigrations(setupConnection)
      setupConnection.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)')
        .run(7, 'Java', 'java')
      const insertDocument = setupConnection.prepare(`
        INSERT INTO documents (id, path, title, summary, created_at, updated_at)
        VALUES (?, ?, ?, '', 1, 100)
      `)
      const insertAssociation = setupConnection.prepare(
        'INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)',
      )
      for (const documentId of ['doc-a', 'doc-b']) {
        insertDocument.run(documentId, `${documentId}/note`, documentId)
        insertAssociation.run(documentId, 7)
      }

      const operation = {
        kind: 'rename',
        sourceTagId: 7,
        destinationName: 'Backend',
      } as const
      const preview = previewTagOperation(setupConnection, operation)
      const databaseGeneration = (setupConnection.prepare(`
        SELECT database_generation
        FROM tag_undo_state
        WHERE state_id = 1
      `).get() as { database_generation: string }).database_generation
      const beforeAssociations = setupConnection.prepare(`
        SELECT document_id, association_id
        FROM document_tags
        ORDER BY document_id
      `).all()
      const beforeVersions = setupConnection.prepare(`
        SELECT id, updated_at
        FROM documents
        ORDER BY id
      `).all()

      // Hold the SQLite writer slot while both independent runtimes finish
      // discovery, acquire their own document locks, and reach BEGIN IMMEDIATE.
      // This is a deterministic SQLite barrier, not a timing-based sleep.
      gateConnection = new Database(databasePath)
      gateConnection.pragma('foreign_keys = ON')
      gateConnection.pragma('busy_timeout = 15000')
      expect(String(gateConnection.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
      gateConnection.exec('BEGIN IMMEDIATE')

      workers.push(spawnWalWorker(databasePath, operation, preview.planFingerprint, 'A'))
      workers.push(spawnWalWorker(databasePath, operation, preview.planFingerprint, 'B'))
      let readyTimeoutHandle: ReturnType<typeof setTimeout> | undefined
      const readyTimeout = new Promise<never>((_, reject) => {
        readyTimeoutHandle = setTimeout(
          () => reject(new Error('two-process WAL workers did not reach the transaction barrier')),
          15_000,
        )
      })
      let ready: WalWorkerReady[]
      try {
        ready = await Promise.race([
          Promise.all(workers.map((worker) => worker.ready)),
          readyTimeout,
        ])
      } finally {
        if (readyTimeoutHandle) clearTimeout(readyTimeoutHandle)
      }
      expect(ready).toHaveLength(2)
      expect(new Set(ready.map((worker) => worker.pid)).size).toBe(2)
      expect(new Set(ready.map((worker) => worker.connectionId)).size).toBe(2)
      expect(ready.every((worker) => worker.journalMode === 'wal')).toBe(true)
      expect(ready.every((worker) => worker.databaseGeneration === databaseGeneration)).toBe(true)

      // Both workers have reached the real transaction boundary in separate
      // Node runtimes. Releasing this lock lets SQLite serialize the writers.
      gateConnection.exec('ROLLBACK')
      const outcomes = await Promise.all(workers.map((worker) => worker.result))
      await Promise.all(workers.map((worker) => worker.close))

      const winners = outcomes.filter((outcome) => outcome.ok)
      const losers = outcomes.filter((outcome) => !outcome.ok)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0]!.error?.code).toBe('PREVIEW_STALE')
      const winningResult = winners[0]!.result
      expect(winningResult).toBeDefined()

      thirdConnection = new Database(databasePath)
      thirdConnection.pragma('foreign_keys = ON')
      expect(String(thirdConnection.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')

      expect(thirdConnection.prepare('SELECT id, name, normalized_name FROM tags ORDER BY id').all())
        .toEqual([{ id: 7, name: 'Backend', normalized_name: 'backend' }])
      const afterAssociations = thirdConnection.prepare(`
        SELECT document_id, association_id
        FROM document_tags
        ORDER BY document_id
      `).all()
      expect(afterAssociations).toEqual(beforeAssociations)

      const records = thirdConnection.prepare(`
        SELECT *
        FROM tag_undo_records
        ORDER BY record_id
      `).all() as Array<Record<string, unknown>>
      expect(records).toHaveLength(1)
      const record = records[0]!
      expect(record).toMatchObject({
        original_operation_id: winningResult!.operationId,
        original_result_id: winningResult!.resultId,
        kind: 'rename',
        lifecycle: 'latest',
        source_tag_id: 7,
        source_before_name: 'Java',
        source_before_normalized_name: 'java',
        source_after_exists: 1,
        source_after_name: 'Backend',
        source_after_normalized_name: 'backend',
        association_remove_count: 0,
        association_add_count: 0,
        version_update_count: 2,
      })
      expect(thirdConnection.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
        .toEqual({ count: 0 })

      const undoState = thirdConnection.prepare(`
        SELECT database_generation, current_record_id, last_superseded_record_id
        FROM tag_undo_state
        WHERE state_id = 1
      `).get() as {
        database_generation: string
        current_record_id: string | null
        last_superseded_record_id: string | null
      }
      expect(undoState.database_generation).toBe(databaseGeneration)
      expect(undoState.current_record_id).toBe(record.record_id)
      expect(undoState.last_superseded_record_id).toBeNull()

      const afterVersions = thirdConnection.prepare(`
        SELECT id, updated_at
        FROM documents
        ORDER BY id
      `).all() as Array<{ id: string; updated_at: number }>
      expect(afterVersions).toHaveLength(2)
      for (const [index, version] of afterVersions.entries()) {
        const before = (beforeVersions[index] as { id: string; updated_at: number })
        expect(version.id).toBe(before.id)
        expect(version.updated_at).toBeGreaterThan(before.updated_at)
      }

      expect(thirdConnection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(thirdConnection.prepare('PRAGMA integrity_check').get())
        .toEqual({ integrity_check: 'ok' })

      // A fresh third connection sees the same committed state, proving the
      // result was durable and not a connection-local artifact.
      expect(thirdConnection.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get())
        .toEqual({ count: 1 })
      expect(thirdConnection.prepare('SELECT current_record_id FROM tag_undo_state').get())
        .toEqual({ current_record_id: record.record_id })
    } finally {
      if (gateConnection?.open) {
        try {
          gateConnection.exec('ROLLBACK')
        } catch {
          // The normal path releases the barrier before the workers finish.
        }
      }
      for (const worker of workers) {
        if (!worker.child.killed) worker.child.kill()
      }
      await Promise.allSettled(workers.map((worker) => worker.result))
      await Promise.allSettled(workers.map((worker) => worker.close))
      if (thirdConnection?.open) thirdConnection.close()
      if (gateConnection?.open) gateConnection.close()
      if (setupConnection?.open) setupConnection.close()
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 45_000)
})

describe('T2.1-2 Undo planner and Preview', () => {
  it('fails closed when Undo foundation tables are missing', () => {
    db.exec('DROP TABLE tag_undo_state')

    expect(() => getTagUndoAvailability(db)).not.toThrow()
    expect(getTagUndoAvailability(db)).toMatchObject({
      state: 'unavailable',
      validation: 'temporary-unavailable',
      reasonCode: 'TAG_MANAGEMENT_UNAVAILABLE',
      recordId: null,
    })
    expect(() => previewTagUndo(db)).not.toThrow()
    expect(previewTagUndo(db)).toMatchObject({
      state: 'unavailable',
      validation: 'temporary-unavailable',
      reasonCode: 'TAG_MANAGEMENT_UNAVAILABLE',
      undoFingerprint: null,
    })
  })

  it('does not inspect unsafe Undo tables after health fails', () => {
    db.exec('DROP TABLE tag_undo_state')
    const queries: string[] = []
    const tracedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            queries.push(sql)
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as Database.Database

    expect(() => previewTagUndo(tracedDb)).not.toThrow()
    expect(queries.some((query) => /FROM tag_undo_(state|records)/i.test(query))).toBe(false)
  })

  it('fails closed when the Undo records table is missing', () => {
    db.exec('DROP TABLE tag_undo_association_deltas; DROP TABLE tag_undo_state; DROP TABLE tag_undo_records')

    expect(() => getTagUndoAvailability(db)).not.toThrow()
    expect(previewTagUndo(db)).toMatchObject({
      state: 'unavailable',
      validation: 'temporary-unavailable',
      reasonCode: 'TAG_MANAGEMENT_UNAVAILABLE',
      recordId: null,
    })
  })

  it('fails closed for an invalid or incompatible Undo schema', () => {
    db.exec('DROP INDEX idx_tag_undo_deltas_record_document')

    expect(() => previewTagUndo(db)).not.toThrow()
    expect(previewTagUndo(db)).toMatchObject({
      state: 'unavailable',
      validation: 'temporary-unavailable',
      reasonCode: 'TAG_MANAGEMENT_UNAVAILABLE',
    })
  })

  it('classifies unsupported and corrupt retained state without parsing health reason text', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const recordId = getTagUndoAvailability(db).recordId!

    db.prepare('UPDATE tag_undo_records SET record_contract_version = ? WHERE record_id = ?')
      .run('tag-undo-record-v999', recordId)
    expect(initializeTagUndoFoundationHealth(db)).toMatchObject({
      state: 'unavailable',
      category: 'terminal',
    })
    expect(previewTagUndo(db)).toMatchObject({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_RECORD_CORRUPT',
      recordId: null,
    })

    db.prepare('UPDATE tag_undo_records SET record_contract_version = ?, database_generation = ? WHERE record_id = ?')
      .run('tag-undo-record-v1', 'deadbeef', recordId)
    expect(initializeTagUndoFoundationHealth(db)).toMatchObject({
      state: 'unavailable',
      category: 'terminal',
    })
    expect(previewTagUndo(db)).toMatchObject({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_RECORD_CORRUPT',
    })

    db.prepare('UPDATE tag_undo_records SET database_generation = ?, association_remove_count = ? WHERE record_id = ?')
      .run((state() as { database_generation: string }).database_generation, 1, recordId)
    expect(initializeTagUndoFoundationHealth(db)).toMatchObject({
      state: 'unavailable',
      category: 'terminal',
    })
    expect(previewTagUndo(db)).toMatchObject({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_RECORD_CORRUPT',
    })
  })

  it('returns a bounded unavailable read model before any operation exists', () => {
    const availability = getTagUndoAvailability(db)
    expect(availability).toMatchObject({
      supported: true,
      state: 'unavailable',
      validation: 'temporary-unavailable',
      recordId: null,
      originalOperationId: null,
      originalResultId: null,
      kind: null,
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 0,
    })
  })

  it('builds Rename and Display Rename previews from the current stable-ID membership', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-b', [7])
    seedDocument('doc-a', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })

    const preview = previewTagUndo(db)
    expect(preview).toMatchObject({
      state: 'available',
      validation: 'safe',
      kind: 'rename',
      displayOnly: false,
      sourceBefore: { id: 7, displayName: 'Java', normalizedName: 'java' },
      sourceAfter: { id: 7, displayName: 'Backend', normalizedName: 'backend' },
      affectedCount: 2,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 2,
      sample: [
        { id: 'doc-a', path: 'doc-a/note', title: 'doc-a' },
        { id: 'doc-b', path: 'doc-b/note', title: 'doc-b' },
      ],
    })
    expect(preview.undoFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.undoContractVersion).toBe('tag-undo-fingerprint-v1')
    expect(Object.hasOwn(preview, 'requiredDocuments')).toBe(false)
    expect(Object.hasOwn(preview, 'operationOwnedAssociations')).toBe(false)

    const pageOne = previewTagUndoPage(db, {
      recordId: preview.recordId,
      undoFingerprint: preview.undoFingerprint!,
      limit: 1,
    })
    expect(pageOne.sample).toEqual([{ id: 'doc-a', path: 'doc-a/note', title: 'doc-a' }])
    expect(pageOne.nextCursor).toBe('doc-a')
    const pageTwo = previewTagUndoPage(db, {
      recordId: preview.recordId,
      undoFingerprint: preview.undoFingerprint!,
      afterDocumentId: pageOne.nextCursor,
      limit: 1,
    })
    expect(pageTwo.sample).toEqual([{ id: 'doc-b', path: 'doc-b/note', title: 'doc-b' }])
    expect(pageTwo.nextCursor).toBeNull()

    db.prepare('UPDATE documents SET title = ?, summary = ?, updated_at = ? WHERE id = ?')
      .run('changed title', 'changed summary', 999, 'doc-a')
    expect(previewTagUndo(db).undoFingerprint).toBe(preview.undoFingerprint)

    seedTag(20, 'Python', 'python')
    seedDocument('doc-c', [7, 20])
    const changedMembership = previewTagUndo(db)
    expect(changedMembership.validation).toBe('safe')
    expect(changedMembership.undoFingerprint).not.toBe(preview.undoFingerprint)
    expect(() => previewTagUndoPage(db, {
      recordId: preview.recordId,
      undoFingerprint: preview.undoFingerprint!,
      limit: 1,
    })).toThrowError(expect.objectContaining({ code: 'UNDO_STALE' }))

    db.exec('DELETE FROM documents; DELETE FROM tags;')
    seedTag(7, 'Java', 'java')
    seedDocument('display-doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' })
    const displayPreview = previewTagUndo(db)
    expect(displayPreview).toMatchObject({
      validation: 'safe',
      kind: 'rename',
      displayOnly: true,
      sourceBefore: { id: 7, displayName: 'Java', normalizedName: 'java' },
      sourceAfter: { id: 7, displayName: 'JAVA', normalizedName: 'java' },
      affectedCount: 1,
    })
  })

  it('plans Merge inverse scope with exact created-destination provenance', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(20, 'Python', 'python')
    seedDocument('source-only', [7])
    seedDocument('overlap', [7, 9])
    seedDocument('destination-only', [9, 20])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })

    const plan = buildTagUndoPlan(db)
    expect(plan).toMatchObject({
      state: 'available',
      validation: 'safe',
      kind: 'merge',
      sourceBefore: { id: 7, displayName: 'Java', normalizedName: 'java' },
      sourceAfter: null,
      destinationBefore: { id: 9, displayName: 'Backend', normalizedName: 'backend' },
      destinationAfter: { id: 9, displayName: 'Backend', normalizedName: 'backend' },
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 1,
      versionUpdateCount: 2,
      requiredDocumentIds: ['overlap', 'source-only'],
    })
    expect(plan.requiredDocuments.map((document) => document.id)).toEqual(['overlap', 'source-only'])
    expect(plan.currentCreatedDestinationAssociations).toHaveLength(1)
    expect(plan.currentCreatedDestinationAssociations[0]).toMatchObject({
      documentId: 'source-only',
      tagId: 9,
    })
    expect(plan.requiredDocumentIds).not.toContain('destination-only')
    expect(previewTagUndo(db).sample.map((document) => document.id)).toEqual(['overlap', 'source-only'])
  })

  it('plans Remove, including an orphan, without allocating a replacement ID', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    seedDocument('doc-b', [7])
    await apply({ kind: 'remove', sourceTagId: 7 })
    const preview = previewTagUndo(db)
    expect(preview).toMatchObject({
      state: 'available',
      validation: 'safe',
      kind: 'remove',
      sourceBefore: { id: 7, displayName: 'Java', normalizedName: 'java' },
      sourceAfter: null,
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 0,
      versionUpdateCount: 2,
    })

    db.exec('DELETE FROM documents; DELETE FROM tags;')
    seedTag(20, 'Orphan', 'orphan')
    await apply({ kind: 'remove', sourceTagId: 20 })
    const orphan = previewTagUndo(db)
    expect(orphan).toMatchObject({
      state: 'available',
      validation: 'safe',
      kind: 'remove',
      sourceBefore: { id: 20, displayName: 'Orphan', normalizedName: 'orphan' },
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 0,
      sample: [],
      nextCursor: null,
    })
  })

  it('classifies stable-ID, identity, document, and association provenance conflicts without consuming', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('source-only', [7])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    const created = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'source-only' AND tag_id = 9
    `).get() as { association_id: number }
    const recordId = (getTagUndoAvailability(db).recordId)

    db.prepare('DELETE FROM document_tags WHERE association_id = ?').run(created.association_id)
    db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('source-only', 9)
    const readded = previewTagUndo(db)
    expect(readded.validation).toBe('conflict')
    expect(readded.reasonCode).toBe('UNDO_ASSOCIATION_CONFLICT')
    expect((state() as { current_record_id: string }).current_record_id).toBe(recordId)

    db.exec('DELETE FROM documents; DELETE FROM tags;')
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'remove', sourceTagId: 7 })
    const removeRecordId = getTagUndoAvailability(db).recordId
    seedTag(7, 'Other', 'other')
    expect(previewTagUndo(db)).toMatchObject({
      validation: 'conflict',
      reasonCode: 'UNDO_SOURCE_ID_OCCUPIED',
    })
    db.prepare('DELETE FROM tags WHERE id = 7').run()
    seedTag(20, 'Java', 'java')
    expect(previewTagUndo(db)).toMatchObject({
      validation: 'conflict',
      reasonCode: 'UNDO_SOURCE_IDENTITY_OCCUPIED',
    })
    db.prepare('DELETE FROM tags WHERE id = 20').run()
    db.prepare('DELETE FROM documents WHERE id = ?').run('doc')
    expect(previewTagUndo(db)).toMatchObject({
      validation: 'conflict',
      reasonCode: 'UNDO_MISSING_DOCUMENT',
    })
    expect((state() as { current_record_id: string }).current_record_id).toBe(removeRecordId)
  })

  it('keeps dynamic conflicts non-consuming and allows a safe fresh Preview after they clear', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const recordId = getTagUndoAvailability(db).recordId
    seedTag(20, 'Java', 'java')
    expect(previewTagUndo(db)).toMatchObject({
      state: 'available',
      validation: 'conflict',
      reasonCode: 'UNDO_SOURCE_IDENTITY_OCCUPIED',
    })
    expect((state() as { current_record_id: string }).current_record_id).toBe(recordId)
    db.prepare('DELETE FROM tags WHERE id = 20').run()
    expect(previewTagUndo(db)).toMatchObject({
      state: 'available',
      validation: 'safe',
      recordId,
    })
  })

  it('proves availability, Preview, and page are read-only and exclude unrelated state', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(20, 'Python', 'python')
    seedDocument('doc', [7, 20])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const before = durableSnapshot()
    const availability = getTagUndoAvailability(db)
    const preview = previewTagUndo(db)
    expect(previewTagUndoPage(db, {
      recordId: preview.recordId,
      undoFingerprint: preview.undoFingerprint!,
      limit: 100,
    }).sample).toHaveLength(1)
    expect(availability.validation).toBe('safe')
    expect(durableSnapshot()).toEqual(before)

    db.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run('doc', 20)
    const afterUnrelatedAssociation = previewTagUndo(db)
    expect(afterUnrelatedAssociation.validation).toBe('safe')
    expect(afterUnrelatedAssociation.undoFingerprint).toBe(preview.undoFingerprint)
    expect(durableSnapshot()).not.toEqual(before)
    expect(db.prepare('SELECT lifecycle FROM tag_undo_records').get()).toEqual({ lifecycle: 'latest' })
  })

  it('rejects malformed bounds and tampered page fingerprints without reading a different plan', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const preview = previewTagUndo(db)
    expect(() => previewTagUndo(db, { limit: 0 })).toThrow(TagUndoPlannerError)
    expect(() => previewTagUndo(db, { limit: 21 })).toThrow(TagUndoPlannerError)
    expect(() => previewTagUndoPage(db, {
      recordId: preview.recordId,
      undoFingerprint: 'f'.repeat(64),
      limit: 1,
    })).toThrowError(expect.objectContaining({ code: 'UNDO_STALE' }))
    expect(() => previewTagUndoPage(db, {
      recordId: preview.recordId,
      undoFingerprint: preview.undoFingerprint!,
      afterDocumentId: 'missing',
      limit: 1,
    })).toThrow(TagUndoPlannerError)
  })

  it('classifies consumed, terminal, and superseded targets without mutating them', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const firstRecordId = getTagUndoAvailability(db).recordId!
    db.prepare(`
      UPDATE tag_undo_records
      SET lifecycle = 'consumed', undo_operation_id = ?, undo_result_id = ?, consumed_at = 200
      WHERE record_id = ?
    `).run('undo-op', 'undo-result', firstRecordId)
    expect(previewTagUndo(db)).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
    })

    db.prepare(`
      UPDATE tag_undo_records
      SET lifecycle = 'terminal', terminal_code = ?, undo_operation_id = NULL,
          undo_result_id = NULL, consumed_at = NULL
      WHERE record_id = ?
    `).run('UNDO_CORRUPT', firstRecordId)
    expect(previewTagUndo(db)).toMatchObject({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_CORRUPT',
    })

    db.prepare('UPDATE tag_undo_state SET current_record_id = NULL, last_superseded_record_id = NULL').run()
    db.exec('DELETE FROM tag_undo_association_deltas; DELETE FROM tag_undo_records; DELETE FROM documents; DELETE FROM tags;')
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const supersededId = getTagUndoAvailability(db).recordId!
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Kotlin' })
    expect(getTagUndoAvailability(db, supersededId)).toMatchObject({
      state: 'superseded',
      validation: 'terminal-unavailable',
      recordId: null,
      reasonCode: 'UNDO_SUPERSEDED',
    })
  })

  it('returns UNDO_SUPERSEDED instead of UNDO_STALE for a reviewed superseded page', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = previewTagUndo(db)
    const firstRecordId = reviewed.recordId!

    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Kotlin' })
    const before = durableSnapshot()

    expect(() => previewTagUndoPage(db, {
      recordId: firstRecordId,
      undoFingerprint: reviewed.undoFingerprint!,
      limit: 1,
    })).toThrowError(expect.objectContaining({ code: 'UNDO_SUPERSEDED' }))
    expect(state()).toMatchObject({
      current_record_id: expect.not.stringMatching(firstRecordId),
      last_superseded_record_id: firstRecordId,
    })
    expect(durableSnapshot()).toEqual(before)
  })

  it('returns UNDO_ALREADY_APPLIED instead of UNDO_STALE for a reviewed consumed page', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = previewTagUndo(db)
    db.prepare(`
      UPDATE tag_undo_records
      SET lifecycle = 'consumed', undo_operation_id = ?, undo_result_id = ?, consumed_at = ?
      WHERE record_id = ?
    `).run('undo-operation', 'undo-result', 200, reviewed.recordId)
    const before = durableSnapshot()

    expect(() => previewTagUndoPage(db, {
      recordId: reviewed.recordId,
      undoFingerprint: reviewed.undoFingerprint!,
      limit: 1,
    })).toThrowError(expect.objectContaining({ code: 'UNDO_ALREADY_APPLIED' }))
    expect(durableSnapshot()).toEqual(before)
  })

  it('preserves terminal-unavailable classification for a reviewed terminal target', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = previewTagUndo(db)
    db.prepare(`
      UPDATE tag_undo_records
      SET lifecycle = 'terminal', terminal_code = ?, undo_operation_id = NULL,
          undo_result_id = NULL, consumed_at = NULL
      WHERE record_id = ?
    `).run('UNDO_CORRUPT', reviewed.recordId)
    const before = durableSnapshot()

    expect(() => previewTagUndoPage(db, {
      recordId: reviewed.recordId,
      undoFingerprint: reviewed.undoFingerprint!,
      limit: 1,
    })).toThrowError(expect.objectContaining({ code: 'UNDO_RECORD_CORRUPT' }))
    expect(durableSnapshot()).toEqual(before)
  })

  it('returns unavailable for an unknown record instead of stale', () => {
    expect(() => previewTagUndoPage(db, {
      recordId: 'unknown-record',
      undoFingerprint: '0'.repeat(64),
      limit: 1,
    })).toThrowError(expect.objectContaining({ code: 'UNDO_TARGET_UNAVAILABLE' }))
  })

  it('keeps Preview query shape bounded as the affected scope grows', async () => {
    seedTag(7, 'Java', 'java')
    for (let index = 0; index < 250; index++) seedDocument(`doc-${String(index).padStart(3, '0')}`, [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })

    const queries: string[] = []
    const tracedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            queries.push(sql)
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as Database.Database
    const preview = previewTagUndo(tracedDb)
    expect(preview.sample).toHaveLength(20)
    expect(queries.length).toBeLessThan(40)
    expect(queries.filter((query) => query.includes('WHERE d.id = ?'))).toHaveLength(0)
    const page = previewTagUndoPage(tracedDb, {
      recordId: preview.recordId,
      undoFingerprint: preview.undoFingerprint!,
      limit: 100,
    })
    expect(page.sample).toHaveLength(100)
    expect(page.nextCursor).toBe('doc-099')
  })
})

describe('T2.1-3 Atomic Undo Apply', () => {
  it('accepts only the reviewed identity pair and rejects an unknown target before mutation', async () => {
    expect(parseTagUndoApplyRequest({
      recordId: 'record-1',
      undoFingerprint: 'a'.repeat(64),
    })).toEqual({
      recordId: 'record-1',
      undoFingerprint: 'a'.repeat(64),
    })
    expect(() => parseTagUndoApplyRequest({
      recordId: 'record-1',
      undoFingerprint: 'a'.repeat(64),
      requiredDocumentIds: ['doc'],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PREVIEW' }))

    const before = durableSnapshot()
    await expect(applyTagUndo(db, {
      recordId: 'missing-record',
      undoFingerprint: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'UNDO_TARGET_UNAVAILABLE' })
    expect(durableSnapshot()).toEqual(before)
  })

  it('undoes Rename atomically, preserves later membership and metadata, and keeps association IDs', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(20, 'Python', 'python')
    seedDocument('doc-a', [7, 20])
    seedDocument('doc-b', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })

    seedDocument('doc-c', [7], 200)
    const reviewed = reviewedUndoInput()
    const beforeAssociations = db.prepare(`
      SELECT association_id, document_id, tag_id
      FROM document_tags
      WHERE tag_id = 7
      ORDER BY association_id
    `).all()
    const beforeVersions = db.prepare(`
      SELECT id, updated_at
      FROM documents
      WHERE id IN ('doc-a', 'doc-b', 'doc-c')
      ORDER BY id
    `).all() as Array<{ id: string; updated_at: number }>
    db.prepare('UPDATE documents SET title = ?, summary = ? WHERE id = ?')
      .run('Later title', 'Later summary', 'doc-a')

    const result = await applyTagUndo(db, reviewed)

    expect(result).toMatchObject({
      recordId: reviewed.recordId,
      kind: 'rename',
      displayOnly: false,
      sourceTag: { id: 7, displayName: 'Java', normalizedName: 'java' },
      destinationTag: null,
      affectedCount: 3,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 3,
      lifecycle: 'consumed',
    })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags WHERE id = 7').get())
      .toEqual({ id: 7, name: 'Java', normalized_name: 'java' })
    expect(db.prepare(`
      SELECT association_id, document_id, tag_id
      FROM document_tags
      WHERE tag_id = 7
      ORDER BY association_id
    `).all()).toEqual(beforeAssociations)
    expect(db.prepare('SELECT title, summary FROM documents WHERE id = ?').get('doc-a'))
      .toEqual({ title: 'Later title', summary: 'Later summary' })
    const afterVersions = db.prepare(`
      SELECT id, updated_at
      FROM documents
      WHERE id IN ('doc-a', 'doc-b', 'doc-c')
      ORDER BY id
    `).all() as Array<{ id: string; updated_at: number }>
    expect(afterVersions).toHaveLength(3)
    for (const [index, row] of afterVersions.entries()) {
      expect(row.updated_at).toBeGreaterThan(beforeVersions[index]!.updated_at)
    }
    expect(parent()).toMatchObject({
      record_id: reviewed.recordId,
      lifecycle: 'consumed',
      terminal_code: null,
      consumed_at: result.committedAt,
      undo_operation_id: result.undoOperationId,
      undo_result_id: result.undoResultId,
    })
    expect(deltas()).toEqual([])
    expect(initializeTagUndoFoundationHealth(db).state).toBe('healthy')
  })

  it('undoes Display Rename without changing physical memberships', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], 300)
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' })
    const reviewed = reviewedUndoInput()
    const association = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'doc' AND tag_id = 7
    `).get()
    const beforeVersion = (db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('doc') as { updated_at: number }).updated_at

    const result = await applyTagUndo(db, reviewed)

    expect(result).toMatchObject({
      kind: 'rename',
      displayOnly: true,
      sourceTag: { id: 7, displayName: 'Java', normalizedName: 'java' },
      affectedCount: 1,
      versionUpdateCount: 1,
    })
    expect(db.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get())
      .toEqual({ name: 'Java', normalized_name: 'java' })
    expect(db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'doc' AND tag_id = 7
    `).get()).toEqual(association)
    expect((db.prepare('SELECT updated_at FROM documents WHERE id = ?').get('doc') as { updated_at: number }).updated_at)
      .toBeGreaterThan(beforeVersion)
  })

  it('undoes mixed Merge scope with exact destination provenance and preserves unrelated changes', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(20, 'Python', 'python')
    seedDocument('source-only', [7])
    seedDocument('overlap', [7, 9])
    seedDocument('destination-only', [9])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    const reviewed = reviewedUndoInput()
    const createdDestination = (db.prepare(`
      SELECT association_id
      FROM tag_undo_association_deltas
      WHERE effect = 'created-destination'
    `).get() as { association_id: number }).association_id
    const originalSource = db.prepare(`
      SELECT association_id
      FROM tag_undo_association_deltas
      WHERE effect = 'removed-source' AND document_id = 'source-only'
    `).get() as { association_id: number }
    const overlapDestination = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'overlap' AND tag_id = 9
    `).get()
    const destinationOnlyDestination = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'destination-only' AND tag_id = 9
    `).get()
    const beforeVersions = db.prepare(`
      SELECT id, updated_at
      FROM documents
      ORDER BY id
    `).all() as Array<{ id: string; updated_at: number }>
    db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('source-only', 20)
    db.prepare('UPDATE documents SET title = ? WHERE id = ?').run('later title', 'overlap')

    const result = await applyTagUndo(db, reviewed)

    expect(result).toMatchObject({
      kind: 'merge',
      sourceTag: { id: 7, displayName: 'Java', normalizedName: 'java' },
      destinationTag: { id: 9, displayName: 'Backend', normalizedName: 'backend' },
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 1,
      versionUpdateCount: 2,
    })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags WHERE id = 7').get())
      .toEqual({ id: 7, name: 'Java', normalized_name: 'java' })
    expect(db.prepare('SELECT association_id FROM document_tags WHERE association_id = ?').get(createdDestination))
      .toBeUndefined()
    expect(db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'overlap' AND tag_id = 9
    `).get()).toEqual(overlapDestination)
    expect(db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'destination-only' AND tag_id = 9
    `).get()).toEqual(destinationOnlyDestination)
    expect(db.prepare('SELECT 1 FROM document_tags WHERE document_id = ? AND tag_id = ?').get('source-only', 20))
      .toEqual({ 1: 1 })
    const restoredSource = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'source-only' AND tag_id = 7
    `).get() as { association_id: number }
    expect(restoredSource.association_id).not.toBe(originalSource.association_id)
    const afterVersions = db.prepare(`
      SELECT id, updated_at
      FROM documents
      ORDER BY id
    `).all() as Array<{ id: string; updated_at: number }>
    for (const row of afterVersions) {
      const before = beforeVersions.find((candidate) => candidate.id === row.id)!
      if (row.id === 'destination-only') expect(row.updated_at).toBe(before.updated_at)
      else expect(row.updated_at).toBeGreaterThan(before.updated_at)
    }
    expect(deltas()).toEqual([])
  })

  it('undoes Remove with a new source ID association and permits orphan Remove', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(20, 'Python', 'python')
    seedDocument('doc-a', [7, 20])
    seedDocument('doc-b', [7])
    await apply({ kind: 'remove', sourceTagId: 7 })
    const reviewed = reviewedUndoInput()
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(30, 'Vue', 'vue')
    db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc-a', 30)
    const beforeVersions = db.prepare('SELECT id, updated_at FROM documents ORDER BY id').all() as Array<{ id: string; updated_at: number }>

    const result = await applyTagUndo(db, reviewed)

    expect(result).toMatchObject({
      kind: 'remove',
      sourceTag: { id: 7, displayName: 'Java', normalizedName: 'java' },
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 0,
      versionUpdateCount: 2,
    })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags WHERE id = 7').get())
      .toEqual({ id: 7, name: 'Java', normalized_name: 'java' })
    expect(db.prepare('SELECT 1 FROM document_tags WHERE document_id = ? AND tag_id = ?').get('doc-a', 20))
      .toEqual({ 1: 1 })
    expect(db.prepare('SELECT 1 FROM document_tags WHERE document_id = ? AND tag_id = ?').get('doc-a', 30))
      .toEqual({ 1: 1 })
    const restored = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'doc-a' AND tag_id = 7
    `).get() as { association_id: number }
    expect(restored.association_id).not.toBeUndefined()
    const afterVersions = db.prepare('SELECT id, updated_at FROM documents ORDER BY id').all() as Array<{ id: string; updated_at: number }>
    for (const row of afterVersions) {
      expect(row.updated_at).toBeGreaterThan(beforeVersions.find((before) => before.id === row.id)!.updated_at)
    }

    seedTag(40, 'Orphan', 'orphan')
    await apply({ kind: 'remove', sourceTagId: 40 })
    const orphan = reviewedUndoInput()
    const orphanResult = await applyTagUndo(db, orphan)
    expect(orphanResult).toMatchObject({
      kind: 'remove',
      affectedCount: 0,
      versionUpdateCount: 0,
      sourceTag: { id: 40, displayName: 'Orphan', normalizedName: 'orphan' },
    })
  })

  it('rejects stale and dynamic-conflict Apply without consuming the parent', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()
    db.prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = 7').run('Drift', 'drift')
    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'UNDO_STALE' })
    expect(parent()).toMatchObject({ lifecycle: 'latest', record_id: reviewed.recordId })

    db.prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = 7').run('Backend', 'backend')
    seedTag(20, 'Java', 'java')
    const conflicted = reviewedUndoInput()
    await expect(applyTagUndo(db, conflicted)).rejects.toMatchObject({ code: 'UNDO_CONFLICT' })
    expect(parent()).toMatchObject({ lifecycle: 'latest', record_id: reviewed.recordId })
    expect(db.prepare('SELECT id, name, normalized_name FROM tags ORDER BY id').all()).toEqual([
      { id: 7, name: 'Backend', normalized_name: 'backend' },
      { id: 20, name: 'Java', normalized_name: 'java' },
    ])
  })

  it('returns already-applied for duplicate Apply without a second mutation', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()
    const first = await applyTagUndo(db, reviewed)
    const afterFirst = durableSnapshot()

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'UNDO_ALREADY_APPLIED' })

    expect(durableSnapshot()).toEqual(afterFirst)
    expect(parent()).toMatchObject({
      lifecycle: 'consumed',
      undo_operation_id: first.undoOperationId,
      undo_result_id: first.undoResultId,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 1 })
  })

  it.each([
    'after-transactional-replan',
    'after-version-staging',
    'after-source-row-restore',
    'after-version-update',
    'after-inverse-postcondition',
    'after-consumed-parent-update',
    'after-child-delta-purge',
    'after-final-postcondition',
    'before-commit',
  ] as TagUndoApplyFailureStage[])('rolls back every Rename Apply failure at %s', async (stage) => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()
    const before = durableSnapshot()
    __setTagUndoApplyHooksForTesting({ failureStage: stage })

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })

    __setTagUndoApplyHooksForTesting(null)
    expect(durableSnapshot()).toEqual(before)
    expect(undoApplyTempTables()).toEqual([])
  })

  it.each(['after-created-destination-delete', 'after-source-association-restore'] as TagUndoApplyFailureStage[])('rolls back Merge inverse failure at %s', async (stage) => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('doc', [7])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    const reviewed = reviewedUndoInput()
    const before = durableSnapshot()
    __setTagUndoApplyHooksForTesting({ failureStage: stage })

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })

    __setTagUndoApplyHooksForTesting(null)
    expect(durableSnapshot()).toEqual(before)
    expect(undoApplyTempTables()).toEqual([])
  })

  it('re-plans after locks and rejects a relevant writer race without inverse SQL', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()
    __setTagUndoApplyHooksForTesting({
      afterLocks: () => db.prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = 7').run('Drift', 'drift'),
    })

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'UNDO_STALE' })

    __setTagUndoApplyHooksForTesting(null)
    expect(parent()).toMatchObject({ lifecycle: 'latest', record_id: reviewed.recordId })
    expect(db.prepare('SELECT name, normalized_name FROM tags WHERE id = 7').get())
      .toEqual({ name: 'Drift', normalized_name: 'drift' })
  })

  it('serializes an Undo versus ordinary Apply race and reports the old target superseded', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(40, 'Orphan', 'orphan')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()
    __setTagUndoApplyHooksForTesting({
      afterLocks: async () => {
        await apply({ kind: 'remove', sourceTagId: 40 })
      },
    })

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'UNDO_SUPERSEDED' })

    __setTagUndoApplyHooksForTesting(null)
    expect(state()).toMatchObject({
      current_record_id: expect.not.stringMatching(reviewed.recordId),
      last_superseded_record_id: reviewed.recordId,
    })
    expect(parent()).toMatchObject({ kind: 'remove', lifecycle: 'latest' })
    expect(db.prepare('SELECT name FROM tags WHERE id = 7').get()).toEqual({ name: 'Backend' })
    expect(db.prepare('SELECT id FROM tags WHERE id = 40').get()).toBeUndefined()
  })

  it('rejects Merge delete-readd provenance races without deleting the replacement ID', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('doc', [7])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    const reviewed = reviewedUndoInput()
    const created = (db.prepare(`
      SELECT association_id
      FROM tag_undo_association_deltas
      WHERE effect = 'created-destination'
    `).get() as { association_id: number }).association_id
    __setTagUndoApplyHooksForTesting({
      afterLocks: () => {
        db.prepare('DELETE FROM document_tags WHERE association_id = ?').run(created)
        db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc', 9)
      },
    })

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'UNDO_STALE' })

    __setTagUndoApplyHooksForTesting(null)
    const replacement = db.prepare(`
      SELECT association_id
      FROM document_tags
      WHERE document_id = 'doc' AND tag_id = 9
    `).get() as { association_id: number }
    expect(replacement.association_id).not.toBe(created)
    expect(parent()).toMatchObject({ lifecycle: 'latest', record_id: reviewed.recordId })
    expect(db.prepare('SELECT id FROM tags WHERE id = 7').get()).toBeUndefined()
  })

  it('fails closed on temporary Undo health before acquiring or mutating the graph', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()
    const before = durableSnapshot()
    db.exec('DROP TABLE tag_undo_state')

    await expect(applyTagUndo(db, reviewed)).rejects.toMatchObject({ code: 'TAG_MANAGEMENT_UNAVAILABLE' })
    expect(db.prepare('SELECT * FROM tags ORDER BY id').all()).toEqual(before.tags)
    expect(db.prepare('SELECT * FROM documents ORDER BY id').all()).toEqual(before.documents)
    expect(db.prepare('SELECT * FROM document_tags ORDER BY document_id, tag_id').all()).toEqual(before.documentTags)
    expect(db.prepare('SELECT * FROM tag_undo_records ORDER BY record_id').all()).toEqual(before.records)
    expect(db.prepare('SELECT * FROM tag_undo_association_deltas ORDER BY record_id, effect, association_id').all())
      .toEqual(before.deltas)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tag_undo_state'").get())
      .toBeUndefined()
  })

  it('allows exactly one Apply across two independent WAL connections', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-undo-apply-wal-'))
    const databasePath = path.join(temporaryRoot, 'nuvyn.db')
    let connectionA: Database.Database | null = null
    let connectionB: Database.Database | null = null
    let verification: Database.Database | null = null
    try {
      connectionA = new Database(databasePath)
      connectionA.pragma('foreign_keys = ON')
      connectionA.pragma('busy_timeout = 15000')
      expect(String(connectionA.pragma('journal_mode = WAL', { simple: true })).toLowerCase()).toBe('wal')
      applyMigrations(connectionA)
      connectionA.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)')
        .run(7, 'Java', 'java')
      connectionA.prepare(`
        INSERT INTO documents (id, path, title, summary, created_at, updated_at)
        VALUES ('doc', 'doc/note', 'doc', '', 1, 100)
      `).run()
      connectionA.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc', 7)
      await applyTagOperation(
        connectionA,
        { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
        previewTagOperation(connectionA, { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' }).planFingerprint,
      )
      const preview = previewTagUndo(connectionA)
      const reviewed = {
        recordId: preview.recordId!,
        undoFingerprint: preview.undoFingerprint!,
      }

      connectionB = new Database(databasePath)
      connectionB.pragma('foreign_keys = ON')
      connectionB.pragma('busy_timeout = 15000')
      expect(String(connectionB.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')

      const outcomes = await Promise.allSettled([
        applyTagUndo(connectionA, reviewed),
        applyTagUndo(connectionB, reviewed),
      ])
      const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled')
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect((failures[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'UNDO_ALREADY_APPLIED' })

      verification = new Database(databasePath)
      verification.pragma('foreign_keys = ON')
      expect(verification.prepare('SELECT name FROM tags WHERE id = 7').get()).toEqual({ name: 'Java' })
      expect(verification.prepare('SELECT lifecycle FROM tag_undo_records').get())
        .toEqual({ lifecycle: 'consumed' })
      expect(verification.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
        .toEqual({ count: 0 })
      expect(verification.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(verification.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      if (verification?.open) verification.close()
      if (connectionB?.open) connectionB.close()
      if (connectionA?.open) connectionA.close()
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 45_000)

  // The P1 reviewer finding: both applyTagUndo calls above run inside the
  // SAME Node process and share the module-global document write lock state.
  // The independent-runtime SQLite/WAL exactly-once contract is proven by the
  // dedicated child-process test below; the same-process pair above is
  // retained as additional JS-lock serialization coverage.
  it('serializes two independent Node runtimes against one WAL with a deterministic gate', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-undo-apply-runtime-wal-'))
    const databasePath = path.join(temporaryRoot, 'nuvyn.db')
    let setupConnection: Database.Database | null = null
    let gateConnection: Database.Database | null = null
    let thirdConnection: Database.Database | null = null
    const workers: UndoApplyWalWorkerHandle[] = []

    try {
      setupConnection = new Database(databasePath)
      setupConnection.pragma('foreign_keys = ON')
      expect(String(setupConnection.pragma('journal_mode = WAL', { simple: true })).toLowerCase()).toBe('wal')
      applyMigrations(setupConnection)
      setupConnection.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)')
        .run(7, 'Java', 'java')
      const insertDocument = setupConnection.prepare(`
        INSERT INTO documents (id, path, title, summary, created_at, updated_at)
        VALUES (?, ?, ?, '', 1, 100)
      `)
      const insertAssociation = setupConnection.prepare(
        'INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)',
      )
      for (const documentId of ['doc-a', 'doc-b']) {
        insertDocument.run(documentId, `${documentId}/note`, documentId)
        insertAssociation.run(documentId, 7)
      }
      await applyTagOperation(
        setupConnection,
        { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
        previewTagOperation(
          setupConnection,
          { kind: 'rename', sourceTagId: 7, destinationName: 'Backend' },
        ).planFingerprint,
      )
      const preview = previewTagUndo(setupConnection)
      const reviewed = {
        recordId: preview.recordId!,
        undoFingerprint: preview.undoFingerprint!,
      }
      const databaseGeneration = (setupConnection.prepare(`
        SELECT database_generation
        FROM tag_undo_state
        WHERE state_id = 1
      `).get() as { database_generation: string }).database_generation
      const beforeAssociations = setupConnection.prepare(`
        SELECT association_id, document_id, tag_id
        FROM document_tags
        ORDER BY association_id
      `).all()
      const beforeVersions = setupConnection.prepare(`
        SELECT id, updated_at
        FROM documents
        ORDER BY id
      `).all() as Array<{ id: string; updated_at: number }>
      const beforeOriginalVersion = beforeVersions[0]!.updated_at

      // Hold the SQLite writer slot while both independent runtimes finish
      // discovery, acquire their own document locks, and reach BEGIN IMMEDIATE.
      // This is a deterministic SQLite barrier, not a timing-based sleep.
      gateConnection = new Database(databasePath)
      gateConnection.pragma('foreign_keys = ON')
      gateConnection.pragma('busy_timeout = 15000')
      expect(String(gateConnection.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
      gateConnection.exec('BEGIN IMMEDIATE')

      workers.push(spawnUndoApplyWalWorker(databasePath, reviewed, 'A'))
      workers.push(spawnUndoApplyWalWorker(databasePath, reviewed, 'B'))
      let readyTimeoutHandle: ReturnType<typeof setTimeout> | undefined
      const readyTimeout = new Promise<never>((_, reject) => {
        readyTimeoutHandle = setTimeout(
          () => reject(new Error('two-process Undo Apply workers did not reach the transaction barrier')),
          15_000,
        )
      })
      let ready: UndoApplyWalWorkerReady[]
      try {
        ready = await Promise.race([
          Promise.all(workers.map((worker) => worker.ready)),
          readyTimeout,
        ])
      } finally {
        if (readyTimeoutHandle) clearTimeout(readyTimeoutHandle)
      }
      expect(ready).toHaveLength(2)
      // Each worker reaches READY in its own Node process with its own module-
      // global document write lock state, then blocks on its own SQLite
      // IMMEDIATE transaction while the parent gate owns the writer slot.
      expect(new Set(ready.map((worker) => worker.pid)).size).toBe(2)
      expect(new Set(ready.map((worker) => worker.connectionId)).size).toBe(2)
      expect(ready.every((worker) => worker.journalMode === 'wal')).toBe(true)
      expect(ready.every((worker) => worker.databaseGeneration === databaseGeneration)).toBe(true)

      // Release the gate so SQLite serializes the two writers at the
      // transaction boundary, not the JS lock seam.
      gateConnection.exec('ROLLBACK')
      const outcomes = await Promise.all(workers.map((worker) => worker.result))
      await Promise.all(workers.map((worker) => worker.close))

      const winners = outcomes.filter((outcome) => outcome.ok)
      const losers = outcomes.filter((outcome) => !outcome.ok)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0]!.error?.code).toBe('UNDO_ALREADY_APPLIED')
      const winningResult = winners[0]!.result
      expect(winningResult).toBeDefined()

      thirdConnection = new Database(databasePath)
      thirdConnection.pragma('foreign_keys = ON')
      expect(String(thirdConnection.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')

      // The inverse mutation is committed exactly once.
      expect(thirdConnection.prepare('SELECT id, name, normalized_name FROM tags ORDER BY id').all())
        .toEqual([{ id: 7, name: 'Java', normalized_name: 'java' }])
      const afterAssociations = thirdConnection.prepare(`
        SELECT association_id, document_id, tag_id
        FROM document_tags
        ORDER BY association_id
      `).all()
      expect(afterAssociations).toEqual(beforeAssociations)

      const record = thirdConnection.prepare(`
        SELECT record_id, original_operation_id, original_result_id, kind,
               lifecycle, terminal_code, undo_operation_id, undo_result_id,
               consumed_at, association_remove_count, association_add_count,
               version_update_count
        FROM tag_undo_records
      `).get() as {
        record_id: string
        original_operation_id: string
        original_result_id: string
        kind: string
        lifecycle: string
        terminal_code: string | null
        undo_operation_id: string | null
        undo_result_id: string | null
        consumed_at: number | null
        association_remove_count: number
        association_add_count: number
        version_update_count: number
      }
      expect(record.lifecycle).toBe('consumed')
      expect(record.terminal_code).toBeNull()
      expect(record.undo_operation_id).toBeTruthy()
      expect(record.undo_result_id).toBeTruthy()
      expect(record.consumed_at).toBeTruthy()
      expect(record.kind).toBe('rename')
      // There is exactly ONE retained Undo parent and ZERO heavy children.
      expect(thirdConnection.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get())
        .toEqual({ count: 1 })
      expect(thirdConnection.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
        .toEqual({ count: 0 })

      const undoState = thirdConnection.prepare(`
        SELECT database_generation, current_record_id, last_superseded_record_id
        FROM tag_undo_state
        WHERE state_id = 1
      `).get() as {
        database_generation: string
        current_record_id: string | null
        last_superseded_record_id: string | null
      }
      expect(undoState.database_generation).toBe(databaseGeneration)
      expect(undoState.current_record_id).toBe(record.record_id)
      expect(undoState.last_superseded_record_id).toBeNull()

      // Exactly-once version evidence: every document advances at most once.
      // The original Rename bumped each document from 100 → 101, then the
      // winning Undo bumped them to a single new monotonic value. The loser
      // is a no-op so no second bump is observable.
      const afterVersions = thirdConnection.prepare(`
        SELECT id, updated_at
        FROM documents
        ORDER BY id
      `).all() as Array<{ id: string; updated_at: number }>
      expect(afterVersions).toHaveLength(2)
      for (const row of afterVersions) {
        expect(row.updated_at).toBeGreaterThan(beforeOriginalVersion)
      }
      // All bumped documents share the single Undo commit timestamp.
      const uniqueBumpValues = new Set(afterVersions.map((row) => row.updated_at))
      expect(uniqueBumpValues.size).toBe(1)

      expect(thirdConnection.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(thirdConnection.prepare('PRAGMA integrity_check').get())
        .toEqual({ integrity_check: 'ok' })
    } finally {
      if (gateConnection?.open) {
        try {
          gateConnection.exec('ROLLBACK')
        } catch {
          // The normal path releases the barrier before the workers finish.
        }
      }
      for (const worker of workers) {
        if (!worker.child.killed) worker.child.kill()
      }
      await Promise.allSettled(workers.map((worker) => worker.result))
      await Promise.allSettled(workers.map((worker) => worker.close))
      if (thirdConnection?.open) thirdConnection.close()
      if (gateConnection?.open) gateConnection.close()
      if (setupConnection?.open) setupConnection.close()
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 45_000)

  // P2 reviewer finding: a consumed record must report its historical inverse
  // association/version counts from the durable parent summary. Heavy child
  // deltas are intentionally purged at successful Apply, so reading counts
  // from now-empty child rows would silently report zero for Merge/Remove.
  it('reports consumed Merge inverse counts from the durable parent summary, not empty children', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedTag(20, 'Python', 'python')
    seedDocument('source-only', [7])
    seedDocument('overlap', [7, 9])
    seedDocument('destination-only', [9, 20])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    const reviewed = reviewedUndoInput()

    const result = await applyTagUndo(db, reviewed)
    expect(result).toMatchObject({
      kind: 'merge',
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 1,
      versionUpdateCount: 2,
    })
    // Heavy children were purged at successful Apply.
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
      .toEqual({ count: 0 })
    // The compact consumed availability must report the SAME inverse counts
    // as the committed Apply result. This was zero before the fix.
    const consumed = getTagUndoAvailability(db)
    expect(consumed).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
      kind: 'merge',
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 1,
      versionUpdateCount: 2,
    })
    // Parent original counts remain intact (Merge captures the forward
    // destination rows it actually created — one source-only destination —
    // plus the two source rows it removed).
    expect(parent()).toMatchObject({
      kind: 'merge',
      lifecycle: 'consumed',
      association_remove_count: 2,
      association_add_count: 1,
      version_update_count: 2,
    })
  })

  it('reports consumed Remove inverse counts from the durable parent summary', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    seedDocument('doc-b', [7])
    await apply({ kind: 'remove', sourceTagId: 7 })
    const reviewed = reviewedUndoInput()

    const result = await applyTagUndo(db, reviewed)
    expect(result).toMatchObject({
      kind: 'remove',
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 0,
      versionUpdateCount: 2,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
      .toEqual({ count: 0 })

    const consumed = getTagUndoAvailability(db)
    expect(consumed).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
      kind: 'remove',
      affectedCount: 2,
      associationAdds: 2,
      associationRemoves: 0,
      versionUpdateCount: 2,
    })
    expect(parent()).toMatchObject({
      kind: 'remove',
      lifecycle: 'consumed',
      association_remove_count: 2,
      association_add_count: 0,
      version_update_count: 2,
    })
  })

  it('reports consumed orphan Remove with all-zero counts', async () => {
    seedTag(40, 'Orphan', 'orphan')
    await apply({ kind: 'remove', sourceTagId: 40 })
    const reviewed = reviewedUndoInput()

    const result = await applyTagUndo(db, reviewed)
    expect(result).toMatchObject({
      kind: 'remove',
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 0,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
      .toEqual({ count: 0 })

    const consumed = getTagUndoAvailability(db)
    expect(consumed).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
      kind: 'remove',
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 0,
    })
    expect(parent()).toMatchObject({
      kind: 'remove',
      lifecycle: 'consumed',
      association_remove_count: 0,
      association_add_count: 0,
      version_update_count: 0,
    })
  })

  it('reports consumed Rename with zero/zero association counts and version update count', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc-a', [7])
    seedDocument('doc-b', [7])
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'Backend' })
    const reviewed = reviewedUndoInput()

    const result = await applyTagUndo(db, reviewed)
    expect(result).toMatchObject({
      kind: 'rename',
      affectedCount: 2,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 2,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
      .toEqual({ count: 0 })

    const consumed = getTagUndoAvailability(db)
    expect(consumed).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
      kind: 'rename',
      affectedCount: 2,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 2,
    })
  })

  it('reports consumed Display Rename with zero/zero association counts', async () => {
    seedTag(7, 'Java', 'java')
    seedDocument('doc', [7], 300)
    await apply({ kind: 'rename', sourceTagId: 7, destinationName: 'JAVA' })
    const reviewed = reviewedUndoInput()

    const result = await applyTagUndo(db, reviewed)
    expect(result).toMatchObject({
      kind: 'rename',
      displayOnly: true,
      affectedCount: 1,
      versionUpdateCount: 1,
      associationAdds: 0,
      associationRemoves: 0,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
      .toEqual({ count: 0 })

    const consumed = getTagUndoAvailability(db)
    expect(consumed).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
      kind: 'rename',
      displayOnly: true,
      affectedCount: 1,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 1,
    })
  })

  // The latest planner must still validate child rows for the inverse count
  // (provenance counts are real evidence before consumption). After Apply
  // succeeds the consumed summary takes over and the helper switches sources.
  it('keeps the latest planner validating child rows before Apply commits', async () => {
    seedTag(7, 'Java', 'java')
    seedTag(9, 'Backend', 'backend')
    seedDocument('source-only', [7])
    seedDocument('overlap', [7, 9])
    await apply({ kind: 'merge', sourceTagId: 7, destinationTagId: 9 })
    const livePreview = previewTagUndo(db)
    expect(livePreview).toMatchObject({
      state: 'available',
      validation: 'safe',
      kind: 'merge',
      associationAdds: 2,
      associationRemoves: 1,
      versionUpdateCount: 2,
      affectedCount: 2,
    })
    // Heavy child rows are still present for the latest planner.
    expect(db.prepare('SELECT COUNT(*) AS count FROM tag_undo_association_deltas').get())
      .toEqual({ count: 3 })
  })
})

describe('T2.1-2 Undo planner WAL/read-snapshot evidence', () => {
  it('rejects a stale page across two WAL connections and recovers after the conflict clears', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-undo-planner-wal-'))
    const databasePath = path.join(temporaryRoot, 'nuvyn.db')
    let connectionA: Database.Database | null = null
    let connectionB: Database.Database | null = null
    try {
      connectionA = new Database(databasePath)
      connectionA.pragma('foreign_keys = ON')
      expect(String(connectionA.pragma('journal_mode = WAL', { simple: true })).toLowerCase()).toBe('wal')
      applyMigrations(connectionA)
      connectionA.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)')
        .run(7, 'Java', 'java')
      connectionA.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)')
        .run(9, 'Backend', 'backend')
      connectionA.prepare(`
        INSERT INTO documents (id, path, title, summary, created_at, updated_at)
        VALUES ('doc', 'doc/note', 'doc', '', 1, 100)
      `).run()
      connectionA.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc', 7)
      const operation = { kind: 'merge', sourceTagId: 7, destinationTagId: 9 } as const
      const operationPreview = previewTagOperation(connectionA, operation)
      await applyTagOperation(connectionA, operation, operationPreview.planFingerprint)
      const reviewed = previewTagUndo(connectionA)
      const created = connectionA.prepare(`
        SELECT association_id
        FROM tag_undo_association_deltas
        WHERE effect = 'created-destination'
      `).get() as { association_id: number }

      connectionB = new Database(databasePath)
      connectionB.pragma('foreign_keys = ON')
      expect(String(connectionB.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
      connectionB.prepare('DELETE FROM document_tags WHERE association_id = ?').run(created.association_id)
      connectionB.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc', 9)

      expect(() => previewTagUndoPage(connectionA!, {
        recordId: reviewed.recordId,
        undoFingerprint: reviewed.undoFingerprint!,
        limit: 1,
      })).toThrowError(expect.objectContaining({ code: 'UNDO_STALE' }))
      expect(previewTagUndo(connectionA!)).toMatchObject({
        state: 'available',
        validation: 'conflict',
        reasonCode: 'UNDO_ASSOCIATION_CONFLICT',
      })
      expect(connectionA!.prepare('SELECT lifecycle FROM tag_undo_records').get())
        .toEqual({ lifecycle: 'latest' })

      connectionB.prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run('doc', 9)
      connectionB.prepare(`
        INSERT INTO document_tags (association_id, document_id, tag_id)
        VALUES (?, ?, ?)
      `).run(created.association_id, 'doc', 9)
      const fresh = previewTagUndo(connectionA!)
      expect(fresh).toMatchObject({ state: 'available', validation: 'safe' })
      expect(fresh.undoFingerprint).toBe(reviewed.undoFingerprint)
      expect(connectionA!.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(connectionA!.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      if (connectionB?.open) connectionB.close()
      if (connectionA?.open) connectionA.close()
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 45_000)
})
