import { hashDraftBaseline } from './draftHash'
import type { UnsavedDraft } from './draftTypes'

export type DraftRecoveryDecisionKind =
  | 'baseline-match'
  | 'divergent'
  | 'unknown'
  | 'missing-source'
  | 'identity-mismatch'

export type RecoveryDiskSnapshot =
  | {
      status: 'ready'
      documentPath: string
      documentId: string | null
      raw: string
      mtime: number
    }
  | {
      status: 'missing'
      documentPath: string
    }
  | {
      status: 'unreadable'
      documentPath: string
      error?: string | null
    }

export interface DraftRecoveryDecision {
  kind: DraftRecoveryDecisionKind
  draft: UnsavedDraft
  disk: RecoveryDiskSnapshot
}

export interface DraftRecoveryDecisionOptions {
  hash?: (content: string) => Promise<string | null>
}

export async function decideDraftRecovery(
  draft: UnsavedDraft,
  disk: RecoveryDiskSnapshot,
  options: DraftRecoveryDecisionOptions = {},
): Promise<DraftRecoveryDecision> {
  let kind: DraftRecoveryDecisionKind

  if (disk.status === 'missing') {
    kind = 'missing-source'
  } else if (disk.status === 'unreadable') {
    kind = 'unknown'
  } else if (disk.documentId === null) {
    kind = 'unknown'
  } else if (disk.documentId !== draft.documentId) {
    kind = 'identity-mismatch'
  } else if (draft.baseContentHash !== null) {
    const hash = await (options.hash ?? hashDraftBaseline)(disk.raw)
    kind = hash === null
      ? 'unknown'
      : hash === draft.baseContentHash ? 'baseline-match' : 'divergent'
  } else if (
    draft.baseModifiedAt !== null
    && Number.isFinite(disk.mtime)
    && disk.mtime >= 0
  ) {
    kind = disk.mtime === draft.baseModifiedAt
      ? 'baseline-match'
      : 'divergent'
  } else {
    kind = 'unknown'
  }

  return { kind, draft, disk }
}
