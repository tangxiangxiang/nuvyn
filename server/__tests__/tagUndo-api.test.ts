import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app from '../index'
import { applyMigrations } from '../db'
import { runTagIdentityMigrationForTesting, resetTagIdentityHealthForTesting } from '../tagIdentityMigration'
import { resetTagUndoFoundationHealthForTesting } from '../tagUndoHealth'
import { __setMetadataDbForTesting } from '../routes/shared'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth'

const mockPathState = vi.hoisted(() => ({ root: '' }))
let root: string
let undoApplyRequestCount = 0
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
applyMigrations(db)
let auth: AuthenticatedTestContext

vi.mock('../paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../paths.js')>()
  return {
    ...original,
    get CONTENT_DIR() { return mockPathState.root || original.CONTENT_DIR },
  }
})

beforeAll(() => {
  __setMetadataDbForTesting(db)
  auth = createAuthenticatedTestContext({ db })
})

afterAll(() => {
  closeAuthTestContext(auth)
  __setMetadataDbForTesting(null)
  db.close()
})

beforeEach(async () => {
  undoApplyRequestCount = 0
  db.exec(`
    DELETE FROM tag_undo_association_deltas;
    UPDATE tag_undo_state
    SET current_record_id = NULL, last_superseded_record_id = NULL, updated_at = 0;
    DELETE FROM tag_undo_records;
    DELETE FROM metadata_migrations;
    DELETE FROM document_tags;
    DELETE FROM documents;
    DELETE FROM tags;
  `)
  db.prepare('DELETE FROM settings WHERE key LIKE ?').run('internal.tags.identity.%')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tag-undo-api-'))
  mockPathState.root = root
})

afterEach(async () => {
  resetTagIdentityHealthForTesting(db)
  resetTagUndoFoundationHealthForTesting(db)
  await fs.rm(root, { recursive: true, force: true })
})

function seedHealthyGraph(documentCount = 1): void {
  db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(7, 'Java', 'java')
  db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(20, 'Backend', 'backend')
  const insertDocument = db.prepare(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES (?, ?, ?, '', 1, 1)
  `)
  const insertAssociation = db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, 7)')
  for (let index = 0; index < documentCount; index += 1) {
    const id = `doc-${String(index).padStart(3, '0')}`
    insertDocument.run(id, id, `Document ${index}`)
    insertAssociation.run(id)
  }
  expect(runTagIdentityMigrationForTesting(db).complete).toBe(true)
}

async function request(
  urlPath: string,
  init: { method?: string; body?: unknown; cookie?: string; contentType?: string; origin?: string } = {},
): Promise<Response> {
  if ((init.method ?? 'GET') === 'POST' && urlPath === '/api/tags/undo/apply') {
    undoApplyRequestCount += 1
  }
  const headers = new Headers()
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  if (init.cookie !== undefined) headers.set('Cookie', init.cookie)
  if (body !== undefined) {
    headers.set('Content-Length', String(Buffer.byteLength(body)))
  }
  if (body !== undefined && init.contentType !== '') {
    headers.set('Content-Type', init.contentType ?? 'application/json')
  }
  if (init.origin !== undefined) headers.set('Origin', init.origin)
  return app.fetch(new Request(`http://localhost${urlPath}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  }))
}

async function authenticated(
  urlPath: string,
  init: Omit<Parameters<typeof request>[1], 'cookie'> = {},
): Promise<Response> {
  return request(urlPath, { ...init, cookie: auth.cookie })
}

async function createRenameRecord(): Promise<{ recordId: string; fingerprint: string }> {
  const ordinaryPreview = await authenticated('/api/tags/operations/preview', {
    method: 'POST',
    body: { kind: 'rename', sourceTagId: 7, destinationName: 'Java Runtime' },
  })
  expect(ordinaryPreview.status).toBe(200)
  const ordinaryPreviewBody = await ordinaryPreview.json() as { planFingerprint: string }
  const ordinaryApply = await authenticated('/api/tags/operations/apply', {
    method: 'POST',
    body: {
      operation: { kind: 'rename', sourceTagId: 7, destinationName: 'Java Runtime' },
      planFingerprint: ordinaryPreviewBody.planFingerprint,
    },
  })
  expect(ordinaryApply.status).toBe(200)
  const availability = await authenticated('/api/tags/undo')
  expect(availability.status).toBe(200)
  const body = await availability.json() as { recordId: string }
  const preview = await authenticated('/api/tags/undo/preview', {
    method: 'POST',
    body: { recordId: body.recordId, limit: 20 },
  })
  expect(preview.status).toBe(200)
  const previewBody = await preview.json() as { recordId: string; undoFingerprint: string }
  return { recordId: previewBody.recordId, fingerprint: previewBody.undoFingerprint }
}

async function createUndoRecord(operation: Record<string, unknown>): Promise<{ recordId: string; fingerprint: string }> {
  const ordinaryPreview = await authenticated('/api/tags/operations/preview', {
    method: 'POST', body: operation,
  })
  expect(ordinaryPreview.status).toBe(200)
  const ordinaryPreviewBody = await ordinaryPreview.json() as { planFingerprint: string }
  const ordinaryApply = await authenticated('/api/tags/operations/apply', {
    method: 'POST',
    body: { operation, planFingerprint: ordinaryPreviewBody.planFingerprint },
  })
  expect(ordinaryApply.status).toBe(200)
  const availability = await authenticated('/api/tags/undo')
  expect(availability.status).toBe(200)
  const availabilityBody = await availability.json() as { recordId: string | null }
  expect(availabilityBody.recordId).toEqual(expect.any(String))
  const preview = await authenticated('/api/tags/undo/preview', {
    method: 'POST', body: { recordId: availabilityBody.recordId, limit: 20 },
  })
  expect(preview.status).toBe(200)
  const previewBody = await preview.json() as { recordId: string; undoFingerprint: string }
  return { recordId: previewBody.recordId, fingerprint: previewBody.undoFingerprint }
}

async function assertApplyConflictMapping(
  operation: Record<string, unknown>,
  mutate: () => void,
  expectedCode: string,
  expectedReasonCode: string,
): Promise<void> {
  const reviewed = await createUndoRecord(operation)
  mutate()
  const conflictPreview = await authenticated('/api/tags/undo/preview', {
    method: 'POST', body: { recordId: reviewed.recordId, limit: 20 },
  })
  expect(conflictPreview.status).toBe(200)
  const conflictPreviewBody = await conflictPreview.json() as {
    validation: string
    reasonCode: string
    undoFingerprint: string
  }
  expect(conflictPreviewBody).toMatchObject({ validation: 'conflict', reasonCode: expectedCode })

  const apply = await authenticated('/api/tags/undo/apply', {
    method: 'POST',
    body: { recordId: reviewed.recordId, undoFingerprint: conflictPreviewBody.undoFingerprint },
  })
  expect(apply.status).toBe(409)
  expect(await apply.json()).toMatchObject({
    code: expectedCode,
    details: { recordId: reviewed.recordId, reasonCode: expectedReasonCode },
  })
}

describe('Undo API authentication and protocol boundary', () => {
  it('rejects unauthenticated access to all four Undo endpoints', async () => {
    const requests: Array<[string, string, unknown?]> = [
      ['/api/tags/undo', 'GET'],
      ['/api/tags/undo/preview', 'POST', { recordId: 'record-1' }],
      ['/api/tags/undo/preview/page', 'POST', { recordId: 'record-1', undoFingerprint: 'a'.repeat(64) }],
      ['/api/tags/undo/apply', 'POST', { recordId: 'record-1', undoFingerprint: 'a'.repeat(64) }],
    ]
    for (const [urlPath, method, body] of requests) {
      const response = await request(urlPath, { method, body })
      expect(response.status, urlPath).toBe(401)
      expect(response.headers.get('cache-control'), urlPath).toBe('no-store')
    }
  })

  it('preserves authenticated JSON, CSRF, and no-store boundaries', async () => {
    seedHealthyGraph()
    const missingType = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: 'record-1' }, contentType: '',
    })
    expect(missingType.status).toBe(415)
    expect(missingType.headers.get('cache-control')).toBe('no-store')

    const wrongOrigin = await authenticated('/api/tags/undo/apply', {
      method: 'POST',
      body: { recordId: 'record-1', undoFingerprint: 'a'.repeat(64) },
      origin: 'https://evil.example',
    })
    expect(wrongOrigin.status).toBe(403)
    expect(wrongOrigin.headers.get('cache-control')).toBe('no-store')

    const malformedJson = await request('/api/tags/undo/preview', {
      method: 'POST', cookie: auth.cookie, contentType: 'application/json',
    })
    expect(malformedJson.status).toBe(400)
    expect(malformedJson.headers.get('cache-control')).toBe('no-store')
  })
})

describe('Undo API public protocol', () => {
  it('returns bounded availability and Preview without child scope or physical IDs', async () => {
    seedHealthyGraph()
    const before = await authenticated('/api/tags/undo')
    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({
      supported: true,
      state: 'unavailable',
      validation: 'temporary-unavailable',
      recordId: null,
      kind: null,
    })

    const reviewed = await createRenameRecord()
    const availability = await authenticated('/api/tags/undo')
    expect(availability.status).toBe(200)
    const availabilityBody = await availability.json() as Record<string, unknown>
    expect(availabilityBody).toMatchObject({ state: 'available', kind: 'rename', recordId: reviewed.recordId })
    expect(availabilityBody).not.toHaveProperty('operation_json')
    expect(availabilityBody).not.toHaveProperty('documentIds')
    expect(availabilityBody).not.toHaveProperty('associationId')

    const preview = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: reviewed.recordId, limit: 20 },
    })
    expect(preview.status).toBe(200)
    const previewBody = await preview.json() as Record<string, unknown>
    expect(previewBody).toMatchObject({
      state: 'available',
      recordId: reviewed.recordId,
      undoFingerprint: reviewed.fingerprint,
      undoContractVersion: 'tag-undo-fingerprint-v1',
      allowedToApply: true,
      sample: [{ id: 'doc-000' }],
    })
    expect(previewBody).not.toHaveProperty('nextAfterDocumentId')
    expect(previewBody).not.toHaveProperty('requiredDocumentIds')
    expect(previewBody).not.toHaveProperty('operationOwnedAssociations')
    expect(previewBody).not.toHaveProperty('requiredAssociations')
    expect(previewBody).not.toHaveProperty('associationId')
  })

  it('rejects unknown fields and all out-of-bound request values before domain work', async () => {
    seedHealthyGraph()
    const previewBodies = [
      { recordId: 'record-1', extra: true },
      { recordId: 'record-1', limit: 0 },
      { recordId: 'record-1', limit: 21 },
    ]
    for (const body of previewBodies) {
      const response = await authenticated('/api/tags/undo/preview', { method: 'POST', body })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_OPERATION' })
    }

    for (const body of [
      { recordId: 'record-1', undoFingerprint: 'A'.repeat(64) },
      { recordId: 'record-1', undoFingerprint: 'a'.repeat(64), limit: 101 },
      { recordId: 'record-1', undoFingerprint: 'a'.repeat(64), documentIds: [] },
    ]) {
      const response = await authenticated('/api/tags/undo/preview/page', { method: 'POST', body })
      expect(response.status).toBe(400)
    }

    for (const body of [
      { recordId: 'record-1', undoFingerprint: 'a'.repeat(63) },
      { recordId: 'record-1', undoFingerprint: 'a'.repeat(64), sourceTagId: 7 },
    ]) {
      const response = await authenticated('/api/tags/undo/apply', { method: 'POST', body })
      expect(response.status).toBe(400)
    }
  })

  it('canonicalizes unknown targets to UNDO_UNAVAILABLE on every public operation route', async () => {
    seedHealthyGraph()
    const preview = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: 'missing-record', limit: 20 },
    })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      state: 'unavailable',
      reasonCode: 'UNDO_UNAVAILABLE',
    })

    const page = await authenticated('/api/tags/undo/preview/page', {
      method: 'POST',
      body: { recordId: 'missing-record', undoFingerprint: 'a'.repeat(64), limit: 1 },
    })
    expect(page.status).toBe(409)
    expect(await page.json()).toMatchObject({ code: 'UNDO_UNAVAILABLE' })

    const apply = await authenticated('/api/tags/undo/apply', {
      method: 'POST',
      body: { recordId: 'missing-record', undoFingerprint: 'a'.repeat(64) },
    })
    expect(apply.status).toBe(409)
    const applyBody = await apply.json() as Record<string, unknown>
    expect(applyBody.code).toBe('UNDO_UNAVAILABLE')
    expect(JSON.stringify(applyBody)).not.toContain('UNDO_TARGET_UNAVAILABLE')
  })

  it('canonicalizes corrupt conflict and terminal diagnostics at the public route boundary', async () => {
    seedHealthyGraph()
    const reviewed = await createUndoRecord({ kind: 'rename', sourceTagId: 7, destinationName: 'Java Runtime' })
    db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)')
      .run(21, '#Java', 'java')

    const conflictPreview = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: reviewed.recordId, limit: 20 },
    })
    expect(conflictPreview.status).toBe(200)
    const conflictPreviewBody = await conflictPreview.json() as { reasonCode: string; undoFingerprint: string }
    expect(conflictPreviewBody.reasonCode).toBe('UNDO_RECORD_CORRUPT')

    const conflictApply = await authenticated('/api/tags/undo/apply', {
      method: 'POST', body: { recordId: reviewed.recordId, undoFingerprint: conflictPreviewBody.undoFingerprint },
    })
    expect(conflictApply.status).toBe(409)
    expect(await conflictApply.json()).toMatchObject({
      code: 'UNDO_RECORD_CORRUPT',
      details: { recordId: reviewed.recordId, reasonCode: 'UNDO_MALFORMED_TAG' },
    })

    db.prepare(`
      UPDATE tag_undo_records
      SET lifecycle = 'terminal', terminal_code = ?, undo_operation_id = NULL,
          undo_result_id = NULL, consumed_at = NULL
      WHERE record_id = ?
    `).run('INTERNAL_TERMINAL_DIAGNOSTIC', reviewed.recordId)
    const availability = await authenticated('/api/tags/undo')
    expect(availability.status).toBe(200)
    const availabilityBody = await availability.json() as Record<string, unknown>
    expect(availabilityBody).toMatchObject({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_RECORD_CORRUPT',
    })
    expect(JSON.stringify(availabilityBody)).not.toContain('INTERNAL_TERMINAL_DIAGNOSTIC')

    const preview = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: reviewed.recordId, limit: 20 },
    })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_RECORD_CORRUPT',
    })
  })

  it('returns a superseded tombstone after committed Undo and a later ordinary Apply', async () => {
    seedHealthyGraph()
    const first = await createRenameRecord()
    const undoApply = await authenticated('/api/tags/undo/apply', {
      method: 'POST',
      body: { recordId: first.recordId, undoFingerprint: first.fingerprint },
    })
    expect(undoApply.status).toBe(200)
    expect(await undoApply.json()).toMatchObject({
      undoRecordId: first.recordId,
      lifecycle: 'consumed',
    })

    const consumed = await authenticated(`/api/tags/undo?recordId=${encodeURIComponent(first.recordId)}`)
    expect(consumed.status).toBe(200)
    expect(await consumed.json()).toMatchObject({
      state: 'consumed',
      validation: 'terminal-unavailable',
      recordId: first.recordId,
      reasonCode: 'UNDO_ALREADY_APPLIED',
    })

    const second = await createUndoRecord({ kind: 'rename', sourceTagId: 7, destinationName: 'Kotlin' })
    expect(second.recordId).not.toBe(first.recordId)

    expect(db.prepare('SELECT current_record_id, last_superseded_record_id FROM tag_undo_state').get())
      .toEqual({ current_record_id: second.recordId, last_superseded_record_id: first.recordId })
    expect(db.prepare('SELECT record_id FROM tag_undo_records').all())
      .toEqual([{ record_id: second.recordId }])

    const response = await authenticated(`/api/tags/undo?recordId=${encodeURIComponent(first.recordId)}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'superseded',
      validation: 'terminal-unavailable',
      recordId: null,
      originalOperationId: null,
      originalResultId: null,
      kind: null,
      displayOnly: false,
      committedAt: null,
      sourceBefore: null,
      sourceAfter: null,
      destinationBefore: null,
      destinationAfter: null,
      affectedCount: 0,
      associationAdds: 0,
      associationRemoves: 0,
      versionUpdateCount: 0,
      reasonCode: 'UNDO_SUPERSEDED',
    })
    const current = await authenticated('/api/tags/undo')
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({
      state: 'available',
      validation: 'safe',
      recordId: second.recordId,
      sourceBefore: { id: 7, normalizedName: 'java', displayName: 'Java' },
      sourceAfter: { id: 7, normalizedName: 'kotlin', displayName: 'Kotlin' },
    })
    expect(undoApplyRequestCount).toBe(1)
  })

  it('maps stable-ID conflicts to the approved public code', async () => {
    seedHealthyGraph()
    await assertApplyConflictMapping(
      { kind: 'remove', sourceTagId: 7 },
      () => db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(7, 'Other', 'other'),
      'UNDO_STABLE_ID_CONFLICT',
      'UNDO_SOURCE_ID_OCCUPIED',
    )
  })

  it('maps identity, document, association, and post-state conflicts to stable public codes', async () => {
    seedHealthyGraph()
    await assertApplyConflictMapping(
      { kind: 'remove', sourceTagId: 7 },
      () => db.prepare('INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)').run(21, 'Java', 'java'),
      'UNDO_IDENTITY_CONFLICT',
      'UNDO_SOURCE_IDENTITY_OCCUPIED',
    )
  })

  it('maps missing-document conflicts without partially applying Undo', async () => {
    seedHealthyGraph()
    await assertApplyConflictMapping(
      { kind: 'remove', sourceTagId: 7 },
      () => db.prepare('DELETE FROM documents WHERE id = ?').run('doc-000'),
      'UNDO_DOCUMENT_MISSING',
      'UNDO_MISSING_DOCUMENT',
    )
  })

  it('maps operation-owned association replacement to UNDO_ASSOCIATION_CONFLICT', async () => {
    seedHealthyGraph()
    const reviewed = await createUndoRecord({ kind: 'merge', sourceTagId: 7, destinationTagId: 20 })
    const association = db.prepare(`
      SELECT association_id FROM document_tags WHERE document_id = ? AND tag_id = ?
    `).get('doc-000', 20) as { association_id: number }
    db.prepare('DELETE FROM document_tags WHERE association_id = ?').run(association.association_id)
    db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)').run('doc-000', 20)

    const conflictPreview = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: reviewed.recordId, limit: 20 },
    })
    const conflictPreviewBody = await conflictPreview.json() as { reasonCode: string; undoFingerprint: string }
    expect(conflictPreviewBody.reasonCode).toBe('UNDO_ASSOCIATION_CONFLICT')
    const apply = await authenticated('/api/tags/undo/apply', {
      method: 'POST',
      body: { recordId: reviewed.recordId, undoFingerprint: conflictPreviewBody.undoFingerprint },
    })
    expect(apply.status).toBe(409)
    expect(await apply.json()).toMatchObject({
      code: 'UNDO_ASSOCIATION_CONFLICT',
      details: { reasonCode: 'UNDO_ASSOCIATION_CONFLICT' },
    })
  })

  it('maps source post-state drift to UNDO_STABLE_ID_CONFLICT', async () => {
    seedHealthyGraph()
    await assertApplyConflictMapping(
      { kind: 'rename', sourceTagId: 7, destinationName: 'Java Runtime' },
      () => db.prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?').run('Drift', 'drift', 7),
      'UNDO_STABLE_ID_CONFLICT',
      'UNDO_SOURCE_POST_STATE_CHANGED',
    )
  })

  it('supports bounded page continuation and rejects stale fingerprints', async () => {
    seedHealthyGraph(22)
    const reviewed = await createRenameRecord()
    const initial = await authenticated('/api/tags/undo/preview', {
      method: 'POST', body: { recordId: reviewed.recordId, limit: 20 },
    })
    const initialBody = await initial.json() as { nextCursor: string; undoFingerprint: string }
    expect(initialBody.nextCursor).toBe('doc-019')

    const page = await authenticated('/api/tags/undo/preview/page', {
      method: 'POST',
      body: {
        recordId: reviewed.recordId,
        undoFingerprint: initialBody.undoFingerprint,
        afterDocumentId: initialBody.nextCursor,
        limit: 2,
      },
    })
    expect(page.status).toBe(200)
    expect((await page.json() as { sample: Array<{ id: string }> }).sample.map((row) => row.id))
      .toEqual(['doc-020', 'doc-021'])

    const stale = await authenticated('/api/tags/undo/preview/page', {
      method: 'POST',
      body: {
        recordId: reviewed.recordId,
        undoFingerprint: 'b'.repeat(64),
        afterDocumentId: initialBody.nextCursor,
      },
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'UNDO_STALE' })
  })

  it('applies only the reviewed identity and returns a bounded consumed result', async () => {
    seedHealthyGraph()
    const reviewed = await createRenameRecord()
    const response = await authenticated('/api/tags/undo/apply', {
      method: 'POST',
      body: { recordId: reviewed.recordId, undoFingerprint: reviewed.fingerprint },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      undoRecordId: reviewed.recordId,
      kind: 'rename',
      displayOnly: false,
      lifecycle: 'consumed',
      appliedUndoFingerprint: reviewed.fingerprint,
      sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
      destinationTag: null,
    })
    expect(body).not.toHaveProperty('recordId')
    expect(body).not.toHaveProperty('requiredDocuments')
    expect(body).not.toHaveProperty('childDeltas')
    expect(body).not.toHaveProperty('associationId')

    const repeated = await authenticated('/api/tags/undo/apply', {
      method: 'POST',
      body: { recordId: reviewed.recordId, undoFingerprint: reviewed.fingerprint },
    })
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toMatchObject({ code: 'UNDO_ALREADY_APPLIED' })
  })
})
