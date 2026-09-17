import { describe, expect, it, vi } from 'vitest'
import { hashDraftBaseline } from '../draftHash'
import {
  decideDraftRecovery,
  type RecoveryDiskSnapshot,
} from '../draftRecoveryDecision'
import {
  UNSAVED_DRAFT_VERSION,
  type UnsavedDraft,
} from '../draftTypes'

function draft(overrides: Partial<UnsavedDraft> = {}): UnsavedDraft {
  return {
    version: UNSAVED_DRAFT_VERSION,
    vaultId: 'vault',
    documentId: 'document-a',
    documentPath: 'notes/a',
    content: 'unsaved',
    baseContentHash: null,
    baseModifiedAt: 10.5,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function disk(
  overrides: Partial<Extract<RecoveryDiskSnapshot, { status: 'ready' }>> = {},
): Extract<RecoveryDiskSnapshot, { status: 'ready' }> {
  return {
    status: 'ready',
    documentPath: 'notes/a',
    documentId: 'document-a',
    raw: 'disk',
    mtime: 10.5,
    ...overrides,
  }
}

describe('decideDraftRecovery', () => {
  it('classifies matching and divergent hashes for the same identity', async () => {
    const matchingHash = await hashDraftBaseline('disk')
    expect(matchingHash).not.toBeNull()

    await expect(decideDraftRecovery(
      draft({ baseContentHash: matchingHash }),
      disk(),
    )).resolves.toMatchObject({ kind: 'baseline-match' })
    await expect(decideDraftRecovery(
      draft({ baseContentHash: matchingHash }),
      disk({ raw: 'changed' }),
    )).resolves.toMatchObject({ kind: 'divergent' })
  })

  it('uses the hash before an otherwise matching mtime', async () => {
    const hash = await hashDraftBaseline('original')
    await expect(decideDraftRecovery(
      draft({ baseContentHash: hash, baseModifiedAt: 10.5 }),
      disk({ raw: 'changed', mtime: 10.5 }),
    )).resolves.toMatchObject({ kind: 'divergent' })
  })

  it('fails safely when hashing is unavailable', async () => {
    await expect(decideDraftRecovery(
      draft({ baseContentHash: 'hash' }),
      disk(),
      { hash: vi.fn().mockResolvedValue(null) },
    )).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('supports exact fractional mtime fallback', async () => {
    await expect(decideDraftRecovery(
      draft({ baseContentHash: null, baseModifiedAt: 10.625 }),
      disk({ mtime: 10.625 }),
    )).resolves.toMatchObject({ kind: 'baseline-match' })
    await expect(decideDraftRecovery(
      draft({ baseContentHash: null, baseModifiedAt: 10.625 }),
      disk({ mtime: 10.626 }),
    )).resolves.toMatchObject({ kind: 'divergent' })
  })

  it('classifies missing, unreadable, mismatched, and unknown identities safely', async () => {
    await expect(decideDraftRecovery(draft(), {
      status: 'missing',
      documentPath: 'notes/a',
    })).resolves.toMatchObject({ kind: 'missing-source' })
    await expect(decideDraftRecovery(draft(), {
      status: 'unreadable',
      documentPath: 'notes/a',
      error: 'private',
    })).resolves.toMatchObject({ kind: 'unknown' })
    await expect(decideDraftRecovery(
      draft(),
      disk({ documentId: 'replacement' }),
    )).resolves.toMatchObject({ kind: 'identity-mismatch' })
    await expect(decideDraftRecovery(
      draft(),
      disk({ documentId: null }),
    )).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('returns unknown without a usable hash or mtime', async () => {
    await expect(decideDraftRecovery(
      draft({ baseContentHash: null, baseModifiedAt: null }),
      disk(),
    )).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('hashes empty disk content normally', async () => {
    const hash = await hashDraftBaseline('')
    await expect(decideDraftRecovery(
      draft({ baseContentHash: hash }),
      disk({ raw: '' }),
    )).resolves.toMatchObject({ kind: 'baseline-match' })
  })

  it('does not mutate its inputs while an asynchronous hash is pending', async () => {
    let resolveHash!: (value: string | null) => void
    const pendingHash = new Promise<string | null>((resolve) => {
      resolveHash = resolve
    })
    const sourceDraft = draft({ baseContentHash: 'expected' })
    const sourceDisk = disk()
    const draftBefore = { ...sourceDraft }
    const diskBefore = { ...sourceDisk }
    const result = decideDraftRecovery(sourceDraft, sourceDisk, {
      hash: () => pendingHash,
    })

    resolveHash('expected')

    await expect(result).resolves.toMatchObject({ kind: 'baseline-match' })
    expect(sourceDraft).toEqual(draftBefore)
    expect(sourceDisk).toEqual(diskBefore)
  })
})
