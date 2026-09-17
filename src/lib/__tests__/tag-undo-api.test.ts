// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyUndo,
  getUndoAvailability,
  getUndoPreviewPage,
  previewUndo,
  recoverCommittedUndo,
  TagUndoApiError,
  type UndoApplyResult,
  type UndoPreview,
} from '../tag-undo-api'

const recordId = 'record-1'
const fingerprint = 'a'.repeat(64)
const sourceBefore = { id: 7, normalizedName: 'java', displayName: 'Java' }
const sourceAfter = { id: 7, normalizedName: 'java-runtime', displayName: 'Java Runtime' }
const document = { id: 'doc-1', path: 'notes/one', title: 'One' }

function availability(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    state: 'available',
    validation: 'safe',
    recordId,
    originalOperationId: 'operation-1',
    originalResultId: 'result-1',
    kind: 'rename',
    displayOnly: false,
    committedAt: 1_700_000_000_000,
    sourceBefore,
    sourceAfter,
    destinationBefore: null,
    destinationAfter: null,
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 0,
    versionUpdateCount: 1,
    reasonCode: null,
    ...overrides,
  }
}

function preview(overrides: Record<string, unknown> = {}): UndoPreview {
  return {
    ...availability(),
    warnings: [],
    sample: [document],
    nextCursor: null,
    undoFingerprint: fingerprint,
    undoContractVersion: 'tag-undo-fingerprint-v1',
    allowedToApply: true,
    ...overrides,
  } as UndoPreview
}

function applyResult(overrides: Partial<UndoApplyResult> = {}): UndoApplyResult {
  return {
    undoRecordId: recordId,
    originalOperationId: 'operation-1',
    originalResultId: 'result-1',
    undoOperationId: 'undo-operation-1',
    undoResultId: 'undo-result-1',
    kind: 'rename',
    displayOnly: false,
    sourceTag: sourceBefore,
    destinationTag: null,
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 0,
    versionUpdateCount: 1,
    committedAt: 1_700_000_000_100,
    appliedUndoFingerprint: fingerprint,
    lifecycle: 'consumed',
    ...overrides,
  }
}

let calls: Array<{ url: string; init: RequestInit }> = []
let responses: Array<{ status: number; body: unknown }> = []

beforeEach(() => {
  calls = []
  responses = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }))
})

describe('Undo client request authority', () => {
  it('constructs exact availability, Preview, page, and Apply requests', async () => {
    responses.push({ status: 200, body: availability() })
    await getUndoAvailability()
    expect(calls[0]).toMatchObject({ url: '/api/tags/undo' })
    expect(calls[0]?.init.body).toBeUndefined()

    responses.push({ status: 200, body: preview() })
    await previewUndo(recordId, 20)
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ recordId, limit: 20 })

    responses.push({ status: 200, body: preview({ sample: [{ id: 'doc-2', path: 'notes/two', title: 'Two' }] }) })
    await getUndoPreviewPage({ recordId, undoFingerprint: fingerprint, afterDocumentId: 'doc-1', limit: 100 })
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      recordId,
      undoFingerprint: fingerprint,
      afterDocumentId: 'doc-1',
      limit: 100,
    })

    responses.push({ status: 200, body: applyResult() })
    await applyUndo(preview())
    expect(JSON.parse(calls[3]?.init.body as string)).toEqual({ recordId, undoFingerprint: fingerprint })
  })

  it('requires a current safe reviewed Preview before Apply', async () => {
    await expect(applyUndo(preview({ allowedToApply: false }))).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    expect(calls).toHaveLength(0)
    await expect(applyUndo({ recordId, undoFingerprint: fingerprint }, preview({ recordId: 'record-2' })))
      .rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    expect(calls).toHaveLength(0)
  })
})

describe('Undo client runtime guards', () => {
  it('rejects malformed availability, enums, tags, counts, and unknown keys', async () => {
    for (const body of [
      { ...availability(), extra: true },
      { ...availability(), state: 'future' },
      { ...availability(), sourceBefore: { id: 7, normalizedName: 'java' } },
      { ...availability(), affectedCount: -1 },
      { ...availability(), kind: 'remove', sourceAfter },
      { ...availability(), sourceAfter: sourceBefore },
    ]) {
      responses.push({ status: 200, body })
      await expect(getUndoAvailability()).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    }
  })

  it('rejects contradictory Merge destination identity rows', async () => {
    const destination = { id: 20, normalizedName: 'backend', displayName: 'Backend' }
    for (const destinationAfter of [
      { ...destination, displayName: 'Other' },
      { ...destination, normalizedName: 'other' },
    ]) {
      responses.push({
        status: 200,
        body: availability({
          kind: 'merge',
          displayOnly: false,
          sourceAfter: null,
          destinationBefore: destination,
          destinationAfter,
        }),
      })
      await expect(getUndoAvailability()).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    }
  })

  it('binds Preview and page responses to the requested record identity', async () => {
    responses.push({ status: 200, body: preview({ recordId: 'record-2' }) })
    await expect(previewUndo(recordId)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 200, body: preview({ recordId: 'record-2' }) })
    await expect(getUndoPreviewPage({ recordId, undoFingerprint: fingerprint })).rejects.toMatchObject({
      code: 'CLIENT_PROTOCOL_ERROR',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('/api/tags/undo/preview')
    expect(calls[1]?.url).toBe('/api/tags/undo/preview/page')
  })

  it('rejects malformed Preview protocol fields and sample bounds', async () => {
    const cases = [
      { ...preview(), warnings: ['UNKNOWN'] },
      { ...preview(), undoContractVersion: 'tag-undo-fingerprint-v2' },
      { ...preview(), undoFingerprint: 'A'.repeat(64) },
      { ...preview(), sample: Array.from({ length: 21 }, (_, index) => ({ id: `doc-${index}`, path: `doc-${index}`, title: '' })) },
      { ...preview(), sample: [{ ...document, summary: 'not approved' }] },
      { ...preview(), nextCursor: 'other-document' },
    ]
    for (const body of cases) {
      responses.push({ status: 200, body })
      await expect(previewUndo(recordId)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    }
  })

  it('rejects contradictory successful Apply identities and lifecycle', async () => {
    const cases: Array<Partial<UndoApplyResult>> = [
      { undoRecordId: 'wrong-record' },
      { appliedUndoFingerprint: 'b'.repeat(64) },
      { originalOperationId: 'wrong-operation' },
      { kind: 'remove' },
      { displayOnly: true },
      { associationAdds: 1 },
      { lifecycle: 'latest' as never },
    ]
    for (const overrides of cases) {
      responses.push({ status: 200, body: { ...applyResult(), ...overrides } })
      await expect(applyUndo(preview())).rejects.toMatchObject({
        code: 'CLIENT_PROTOCOL_ERROR',
        recoveryRecordId: recordId,
      })
    }
  })

  it('rejects malformed Apply shape and unknown server error envelopes', async () => {
    responses.push({ status: 200, body: { ...applyResult(), childDeltas: [] } })
    await expect(applyUndo(preview())).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 409, body: { error: 'conflict', code: 'UNKNOWN_UNDO_CODE', details: {} } })
    await expect(applyUndo(preview())).rejects.toMatchObject({
      code: 'CLIENT_PROTOCOL_ERROR',
      recoveryRecordId: recordId,
    })

    responses.push({ status: 409, body: { error: 'target unavailable', code: 'UNDO_TARGET_UNAVAILABLE', details: {} } })
    await expect(applyUndo(preview())).rejects.toMatchObject({
      code: 'CLIENT_PROTOCOL_ERROR',
      recoveryRecordId: recordId,
    })
  })
})

describe('Undo client compatibility and committed recovery', () => {
  it('treats an old-server Undo 404 as safe unavailability without fallback mutation', async () => {
    responses.push({ status: 404, body: { error: 'Not Found' } })
    await expect(getUndoAvailability()).rejects.toMatchObject({
      code: 'UNDO_UNAVAILABLE',
      status: 404,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/tags/undo')
  })

  it('treats a legacy non-Undo 503 as safe unavailability without fallback mutation', async () => {
    responses.push({ status: 503, body: { error: 'Service Unavailable' } })
    await expect(getUndoAvailability()).rejects.toMatchObject({
      code: 'UNDO_UNAVAILABLE',
      status: 503,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/tags/undo')
    expect(calls.filter((call) => call.url === '/api/tags/operations/apply')).toHaveLength(0)
  })

  it('retains the submitted record after a contradictory 2xx and recovers with reads only', async () => {
    responses.push({ status: 200, body: { ...applyResult(), undoRecordId: 'wrong-record' } })
    await expect(applyUndo(preview())).rejects.toMatchObject({
      code: 'CLIENT_PROTOCOL_ERROR',
      recoveryRecordId: recordId,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/tags/undo/apply')

    responses.push({ status: 200, body: { ...availability(), state: 'consumed', validation: 'terminal-unavailable', reasonCode: 'UNDO_ALREADY_APPLIED' } })
    await expect(recoverCommittedUndo(recordId)).resolves.toMatchObject({
      recordId,
      state: 'consumed',
      validation: 'terminal-unavailable',
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe('/api/tags/undo?recordId=record-1')
    expect(calls[1]?.init.method).toBeUndefined()
    expect(calls.filter((call) => call.url === '/api/tags/undo/apply')).toHaveLength(1)
  })

  it('accepts a valid superseded tombstone without synthesizing the requested record ID', async () => {
    const superseded = {
      supported: true,
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
    }
    responses.push({ status: 200, body: superseded })
    await expect(recoverCommittedUndo(recordId)).resolves.toMatchObject({
      state: 'superseded',
      validation: 'terminal-unavailable',
      recordId: null,
      reasonCode: 'UNDO_SUPERSEDED',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/tags/undo?recordId=record-1')
    expect(calls.filter((call) => call.url === '/api/tags/undo/apply')).toHaveLength(0)

    for (const malformed of [
      { ...superseded, validation: 'safe' },
      { ...superseded, affectedCount: 1 },
      { ...superseded, kind: 'rename' },
    ]) {
      responses.push({ status: 200, body: malformed })
      await expect(recoverCommittedUndo(recordId)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    }
  })

  it('keeps the reviewed Apply binding strict for source and destination identities', async () => {
    const mergeSource = { id: 7, normalizedName: 'java', displayName: 'Java' }
    const mergeDestination = { id: 20, normalizedName: 'backend', displayName: 'Backend' }
    const reviewed = preview({
      kind: 'merge',
      displayOnly: false,
      sourceBefore: mergeSource,
      sourceAfter: null,
      destinationBefore: mergeDestination,
      destinationAfter: mergeDestination,
      associationAdds: 1,
      associationRemoves: 1,
    })
    const result = applyResult({
      kind: 'merge',
      displayOnly: false,
      sourceTag: mergeSource,
      destinationTag: mergeDestination,
      associationAdds: 1,
      associationRemoves: 1,
    })
    responses.push({ status: 200, body: result })
    await expect(applyUndo(reviewed)).resolves.toMatchObject({ kind: 'merge' })

    responses.push({ status: 200, body: { ...result, destinationTag: { ...mergeDestination, id: 21 } } })
    await expect(applyUndo(reviewed)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR', recoveryRecordId: recordId })
  })

  it('maps known server errors without exposing arbitrary details', async () => {
    responses.push({ status: 503, body: { error: 'Tag management is temporarily unavailable.', code: 'TAG_MANAGEMENT_UNAVAILABLE', details: { healthCode: 'bounded' } } })
    await expect(getUndoAvailability()).rejects.toMatchObject({ code: 'TAG_MANAGEMENT_UNAVAILABLE', status: 503 })
    expect(() => new TagUndoApiError('x', 503, 'TAG_MANAGEMENT_UNAVAILABLE')).not.toThrow()
  })

  it('keeps malformed 2xx responses strict despite legacy 503 compatibility', async () => {
    responses.push({ status: 200, body: { error: 'Service Unavailable' } })
    await expect(getUndoAvailability()).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })
})
