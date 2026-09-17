export const UNSAVED_DRAFT_VERSION = 1 as const

export interface UnsavedDraft {
  version: typeof UNSAVED_DRAFT_VERSION
  vaultId: string
  documentId: string
  documentPath: string
  content: string
  baseContentHash: string | null
  baseModifiedAt: number | null
  createdAt: number
  updatedAt: number
}

export function isUnsavedDraft(value: unknown): value is UnsavedDraft {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<Record<keyof UnsavedDraft, unknown>>
  return candidate.version === UNSAVED_DRAFT_VERSION
    && isNonEmptyString(candidate.vaultId)
    && isNonEmptyString(candidate.documentId)
    && isNonEmptyString(candidate.documentPath)
    && typeof candidate.content === 'string'
    && (candidate.baseContentHash === null
      || typeof candidate.baseContentHash === 'string')
    && (candidate.baseModifiedAt === null
      || isNonNegativeFiniteNumber(candidate.baseModifiedAt))
    && isNonNegativeSafeInteger(candidate.createdAt)
    && isNonNegativeSafeInteger(candidate.updatedAt)
    && candidate.createdAt <= candidate.updatedAt
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
}

export function cloneDraft(draft: UnsavedDraft): UnsavedDraft {
  return { ...draft }
}

export type DraftConflictSource = 'delete-conflict' | 'move-conflict'

export interface DraftConflictRecord {
  version: 1
  /** Unique id within (vaultId, documentId). Two records may coexist
   *  for the same identity — one is the primary IndexedDB draft
   *  (cross-context), the other is the local conflict orphan. */
  conflictId: string
  vaultId: string
  documentId: string
  documentPath: string
  content: string
  baseContentHash: string | null
  baseModifiedAt: number | null
  createdAt: number
  updatedAt: number
  origin: DraftConflictSource
  /** The cross-context record's updatedAt at the time this conflict
   *  was recorded. Lets the UI render both candidates side-by-side. */
  crossContextUpdatedAt: number | null
  recordedAt: number
}

export function cloneConflictRecord(record: DraftConflictRecord): DraftConflictRecord {
  return { ...record }
}

export function isDraftConflictRecord(value: unknown): value is DraftConflictRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof DraftConflictRecord, unknown>>
  return candidate.version === UNSAVED_DRAFT_VERSION
    && typeof candidate.conflictId === 'string'
    && candidate.conflictId.trim().length > 0
    && typeof candidate.vaultId === 'string'
    && candidate.vaultId.trim().length > 0
    && typeof candidate.documentId === 'string'
    && candidate.documentId.trim().length > 0
    && typeof candidate.documentPath === 'string'
    && (candidate.baseContentHash === null
      || typeof candidate.baseContentHash === 'string')
    && (candidate.baseModifiedAt === null
      || (typeof candidate.baseModifiedAt === 'number'
        && Number.isFinite(candidate.baseModifiedAt)
        && candidate.baseModifiedAt >= 0))
    && typeof candidate.content === 'string'
    && typeof candidate.createdAt === 'number'
    && Number.isSafeInteger(candidate.createdAt)
    && candidate.createdAt >= 0
    && typeof candidate.updatedAt === 'number'
    && Number.isSafeInteger(candidate.updatedAt)
    && candidate.updatedAt >= 0
    && (candidate.crossContextUpdatedAt === null
      || (typeof candidate.crossContextUpdatedAt === 'number'
        && Number.isSafeInteger(candidate.crossContextUpdatedAt)
        && (candidate.crossContextUpdatedAt as number) >= 0))
    && typeof candidate.recordedAt === 'number'
    && Number.isSafeInteger(candidate.recordedAt)
    && candidate.recordedAt >= 0
    && (candidate.origin === 'delete-conflict'
      || candidate.origin === 'move-conflict')
}

export function draftsEqual(left: UnsavedDraft, right: UnsavedDraft): boolean {
  return left.version === right.version
    && left.vaultId === right.vaultId
    && left.documentId === right.documentId
    && left.documentPath === right.documentPath
    && left.content === right.content
    && left.baseContentHash === right.baseContentHash
    && left.baseModifiedAt === right.baseModifiedAt
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
}

export function conflictDraftsEqual(
  left: DraftConflictRecord,
  right: DraftConflictRecord,
): boolean {
  return left.version === right.version
    && left.conflictId === right.conflictId
    && left.vaultId === right.vaultId
    && left.documentId === right.documentId
    && left.documentPath === right.documentPath
    && left.content === right.content
    && left.baseContentHash === right.baseContentHash
    && left.baseModifiedAt === right.baseModifiedAt
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.origin === right.origin
    && left.crossContextUpdatedAt === right.crossContextUpdatedAt
    && left.recordedAt === right.recordedAt
}
