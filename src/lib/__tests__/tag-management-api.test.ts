// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTagOperation,
  assertApplyResultMatchesReviewedPreview,
  getTagOperationPreviewPage,
  listManagedTags,
  previewTagOperation,
  type TagOperationApplyResult,
  type TagOperationPreview,
} from '../tag-management-api'

const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'JAVA' }
const fingerprint = 'a'.repeat(64)
const sourceTag = { id: 7, normalizedName: 'java', displayName: 'Java' }
const previewDocument = { id: 'doc-1', path: 'inbox/one', title: 'One' }

function preview(overrides: Partial<TagOperationPreview> = {}): TagOperationPreview {
  return {
    operation,
    sourceTag,
    destinationTag: null,
    requestedDestination: { displayName: 'JAVA', normalizedName: 'java' },
    survivorTag: sourceTag,
    displayOnly: true,
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 0,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 0,
    warnings: [],
    allowedToApply: true,
    planFingerprint: fingerprint,
    healthContractVersion: 'tag-identity-v1',
    sample: [previewDocument],
    nextAfterDocumentId: null,
    ...overrides,
  }
}

function mergePreview(overrides: Partial<TagOperationPreview> = {}): TagOperationPreview {
  return preview({
    operation: mergeOperation,
    sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
    destinationTag,
    requestedDestination: null,
    survivorTag: destinationTag,
    displayOnly: false,
    affectedCount: 2,
    associationAdds: 1,
    associationRemoves: 2,
    duplicateCollapses: 1,
    tagDeletes: 1,
    ...overrides,
  })
}

function applyResult() {
  return {
    operationId: 'operation-1',
    resultId: 'operation-1',
    kind: 'rename' as const,
    operation,
    sourceTagId: 7,
    destinationTagId: null,
    survivorTagId: 7,
    sourceTag: { id: 7, normalizedName: 'java', displayName: 'JAVA' },
    destinationTag: null,
    survivorTag: { id: 7, normalizedName: 'java', displayName: 'JAVA' },
    sourceDisplayName: 'JAVA',
    sourceNormalizedName: 'java',
    destinationDisplayName: null,
    destinationNormalizedName: null,
    survivorDisplayName: 'JAVA',
    survivorNormalizedName: 'java',
    sourceDeleted: false,
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 0,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 0,
    displayOnly: true,
    versionUpdateCount: 1,
    commitTimestamp: 1_700_000_000_000,
    appliedFingerprint: fingerprint,
  }
}

const mergeOperation = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 20 }
const destinationTag = { id: 20, normalizedName: 'backend', displayName: 'Backend' }

function expectClientProtocolError(action: () => void): void {
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    return
  }
  throw new Error('Expected a CLIENT_PROTOCOL_ERROR')
}

function mergeApplyResult(overrides: Partial<TagOperationApplyResult> = {}): TagOperationApplyResult {
  return {
    operationId: 'operation-merge',
    resultId: 'operation-merge',
    kind: 'merge' as const,
    operation: mergeOperation,
    sourceTagId: 7,
    destinationTagId: 20,
    survivorTagId: 20,
    sourceTag: null,
    destinationTag,
    survivorTag: destinationTag,
    sourceDisplayName: null,
    sourceNormalizedName: null,
    destinationDisplayName: 'Backend',
    destinationNormalizedName: 'backend',
    survivorDisplayName: 'Backend',
    survivorNormalizedName: 'backend',
    sourceDeleted: true,
    affectedCount: 1,
    associationAdds: 1,
    associationRemoves: 1,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 1,
    displayOnly: false,
    versionUpdateCount: 1,
    commitTimestamp: 1_700_000_000_000,
    appliedFingerprint: fingerprint,
    ...overrides,
  }
}

function removeApplyResult() {
  return {
    operationId: 'operation-remove',
    resultId: 'operation-remove',
    kind: 'remove' as const,
    operation: { kind: 'remove' as const, sourceTagId: 7 },
    sourceTagId: 7,
    destinationTagId: null,
    survivorTagId: null,
    sourceTag: null,
    destinationTag: null,
    survivorTag: null,
    sourceDisplayName: null,
    sourceNormalizedName: null,
    destinationDisplayName: null,
    destinationNormalizedName: null,
    survivorDisplayName: null,
    survivorNormalizedName: null,
    sourceDeleted: true,
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 1,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 1,
    displayOnly: false,
    versionUpdateCount: 1,
    commitTimestamp: 1_700_000_000_000,
    appliedFingerprint: fingerprint,
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

describe('tag management API runtime guards', () => {
  it('accepts a managed tag with a positive safe ID and bounded count', async () => {
    responses.push({ status: 200, body: [{ id: 7, normalizedName: 'java', displayName: 'Java', documentCount: 3 }] })
    await expect(listManagedTags()).resolves.toEqual([
      { id: 7, normalizedName: 'java', displayName: 'Java', documentCount: 3 },
    ])
  })

  it('rejects unsafe IDs and malformed counts', async () => {
    responses.push({ status: 200, body: [{ id: Number.MAX_SAFE_INTEGER + 1, normalizedName: 'java', displayName: 'Java', documentCount: 1 }] })
    await expect(listManagedTags()).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 200, body: [{ id: 7, normalizedName: 'java', displayName: 'Java', documentCount: -1 }] })
    await expect(listManagedTags()).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('rejects malformed, uppercase, and non-hex fingerprints', async () => {
    responses.push({ status: 200, body: preview({ planFingerprint: 'A'.repeat(64) }) })
    await expect(previewTagOperation(operation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 200, body: preview({ planFingerprint: 'z'.repeat(64) }) })
    await expect(previewTagOperation(operation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('rejects unknown warnings, malformed displayOnly, and overlong samples', async () => {
    responses.push({ status: 200, body: { ...preview(), warnings: ['UNKNOWN'] } as unknown })
    await expect(previewTagOperation(operation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 200, body: { ...preview(), displayOnly: 'yes' } as unknown })
    await expect(previewTagOperation(operation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({
      status: 200,
      body: { ...preview(), sample: Array.from({ length: 21 }, (_, index) => ({ id: `doc-${index}`, path: `doc-${index}`, title: 'x' })) } as unknown,
    })
    await expect(previewTagOperation(operation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('rejects a sample with fields outside the approved bounded contract', async () => {
    responses.push({ status: 200, body: { ...preview(), sample: [{ ...previewDocument, summary: 'secret' }] } as unknown })
    await expect(previewTagOperation(operation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('binds Merge Preview to the submitted stable source and destination IDs', async () => {
    responses.push({ status: 200, body: mergePreview() })
    await expect(previewTagOperation(mergeOperation)).resolves.toMatchObject({
      operation: mergeOperation,
      destinationTag: { id: 20 },
      survivorTag: { id: 20 },
    })

    responses.push({
      status: 200,
      body: mergePreview({
        destinationTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
        survivorTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
      }),
    })
    await expect(previewTagOperation(mergeOperation)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('rejects malformed Apply results and malformed error envelopes safely', async () => {
    responses.push({ status: 200, body: { ...applyResult(), affectedCount: -1 } })
    await expect(applyTagOperation(operation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 500, body: { error: 'internal', code: 'NOT_A_DOMAIN_CODE', details: {} } })
    await expect(applyTagOperation(operation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('rejects Apply results with malformed stable-ID relationships', async () => {
    responses.push({ status: 200, body: { ...applyResult(), sourceTagId: 20 } })
    await expect(applyTagOperation(operation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({ status: 200, body: { ...applyResult(), survivorTagId: 20 } })
    await expect(applyTagOperation(operation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({
      status: 200,
      body: {
        ...applyResult(),
        survivorTag: { id: 20, normalizedName: 'backend', displayName: 'Backend' },
      },
    })
    await expect(applyTagOperation(operation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('keeps Merge and Remove result identities fail-closed', async () => {
    responses.push({
      status: 200,
      body: {
        ...mergeApplyResult(),
        destinationTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
        destinationDisplayName: 'Java',
        destinationNormalizedName: 'java',
        survivorTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
        survivorTagId: 7,
        survivorDisplayName: 'Java',
        survivorNormalizedName: 'java',
      },
    })
    await expect(applyTagOperation(mergeOperation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({
      status: 200,
      body: { ...mergeApplyResult(), survivorTagId: 7 },
    })
    await expect(applyTagOperation(mergeOperation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    responses.push({
      status: 200,
      body: { ...removeApplyResult(), survivorTag: destinationTag, survivorTagId: 20 },
    })
    await expect(applyTagOperation(removeApplyResult().operation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })

    for (const overrides of [
      { sourceDeleted: false },
      { tagCreates: 1 },
      { tagDeletes: 0 },
      { displayOnly: true },
    ]) {
      responses.push({ status: 200, body: { ...mergeApplyResult(), ...overrides } })
      await expect(applyTagOperation(mergeOperation, fingerprint)).rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
    }
  })

  it('accepts the frozen server identity shapes for Merge and Remove', async () => {
    responses.push({ status: 200, body: mergeApplyResult() })
    await expect(applyTagOperation(mergeOperation, fingerprint)).resolves.toMatchObject({
      survivorTagId: 20,
      destinationTagId: 20,
      sourceDeleted: true,
    })

    const removeOperation = removeApplyResult().operation
    responses.push({ status: 200, body: removeApplyResult() })
    await expect(applyTagOperation(removeOperation, fingerprint)).resolves.toMatchObject({
      survivorTagId: null,
      sourceDeleted: true,
    })
  })

  it('binds Merge Apply identity and display ownership to the reviewed Preview', () => {
    const reviewedPreview = mergePreview()
    const validResult = mergeApplyResult()
    expect(() => assertApplyResultMatchesReviewedPreview(validResult, reviewedPreview)).not.toThrow()

    expectClientProtocolError(() => assertApplyResultMatchesReviewedPreview(
      mergeApplyResult({
        destinationTag: { ...destinationTag, displayName: 'BACKEND CHANGED' },
        survivorTag: { ...destinationTag, displayName: 'BACKEND CHANGED' },
        destinationDisplayName: 'BACKEND CHANGED',
        survivorDisplayName: 'BACKEND CHANGED',
      }),
      reviewedPreview,
    ))

    expectClientProtocolError(() => assertApplyResultMatchesReviewedPreview(
      mergeApplyResult({
        destinationTag: { ...destinationTag, normalizedName: 'different' },
        survivorTag: { ...destinationTag, normalizedName: 'different' },
        destinationNormalizedName: 'different',
        survivorNormalizedName: 'different',
      }),
      reviewedPreview,
    ))

    expectClientProtocolError(() => assertApplyResultMatchesReviewedPreview(
      mergeApplyResult({
        survivorTag: { ...destinationTag, displayName: 'Different survivor' },
        survivorDisplayName: 'Different survivor',
      }),
      reviewedPreview,
    ))

    expectClientProtocolError(() => assertApplyResultMatchesReviewedPreview(
      mergeApplyResult({ appliedFingerprint: 'b'.repeat(64) }),
      reviewedPreview,
    ))

    expectClientProtocolError(() => assertApplyResultMatchesReviewedPreview(
      mergeApplyResult({
        operation: { kind: 'merge', sourceTagId: 7, destinationTagId: 21 },
      }),
      reviewedPreview,
    ))
  })
})

describe('tag management API request authority', () => {
  it('sends Preview with only the operation', async () => {
    responses.push({ status: 200, body: preview() })
    await previewTagOperation(operation)
    expect(calls[0]?.init.body).toBe(JSON.stringify(operation))
  })

  it('binds pagination to the exact operation, fingerprint, cursor, and bounded limit', async () => {
    responses.push({ status: 200, body: preview({ sample: [{ id: 'doc-2', path: 'inbox/two', title: 'Two' }] }) })
    await getTagOperationPreviewPage(operation, fingerprint, 'doc-1', 100)
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      operation,
      planFingerprint: fingerprint,
      afterDocumentId: 'doc-1',
      limit: 100,
    })
  })

  it('rejects a continuation response that changes operation authority', async () => {
    responses.push({
      status: 200,
      body: {
        ...preview(),
        operation: { kind: 'rename', sourceTagId: 7, destinationName: 'Other' },
      },
    })
    await expect(getTagOperationPreviewPage(operation, fingerprint, 'doc-1', 100))
      .rejects.toMatchObject({ code: 'CLIENT_PROTOCOL_ERROR' })
  })

  it('sends Apply with exactly operation and the reviewed fingerprint', async () => {
    responses.push({ status: 200, body: applyResult() })
    await applyTagOperation(operation, fingerprint)
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ operation, planFingerprint: fingerprint })
  })
})
