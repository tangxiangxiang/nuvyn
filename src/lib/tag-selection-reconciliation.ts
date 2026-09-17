import { normalizeTag } from './tags'
import type {
  ManagedTag,
  TagOperationApplyResult,
  TagOperationRequest,
} from './tag-management-api'
import type {
  UndoApplyResult,
  UndoAvailability,
  UndoPreview,
} from './tag-undo-api'

export interface TagSelectionSnapshot {
  selectedTag: string | null
  selectedTagId: number | null
  selectionEpoch: number
}

/** Undo uses the same stable selection snapshot contract as ordinary Tag
 * Management. The alias makes the ownership boundary explicit at call sites
 * without creating a second, display-string-based selection model. */
export type UndoSelectionSnapshot = TagSelectionSnapshot

export interface ReconcileTagSelectionInput {
  snapshot: TagSelectionSnapshot
  currentSelectedTag: string | null
  currentSelectionEpoch: number
  operation: TagOperationRequest
  result: TagOperationApplyResult
  managedTags: readonly ManagedTag[]
}

export interface ReconcileCommittedTagSelectionInput {
  snapshot: TagSelectionSnapshot
  currentSelectedTag: string | null
  currentSelectionEpoch: number
  operation: TagOperationRequest
  managedTags: readonly ManagedTag[]
}

export interface ReconcileUndoTagSelectionInput {
  snapshot: UndoSelectionSnapshot
  currentSelectedTag: string | null
  currentSelectionEpoch: number
  /** The reviewed Preview is preferred. A trusted Apply result is sufficient
   * for the normal committed path when VaultView does not retain the Preview. */
  preview?: UndoPreview | null
  result: UndoApplyResult
  managedTags: readonly ManagedTag[]
}

export interface ReconcileCommittedUndoTagSelectionInput {
  snapshot: UndoSelectionSnapshot
  currentSelectedTag: string | null
  currentSelectionEpoch: number
  /** Recovery is read-only. This is the authoritative consumed-record state,
   * never an untrusted contradictory Apply response. */
  availability: UndoAvailability
  managedTags: readonly ManagedTag[]
}

/** Resolve a Phase 1 display value to management identity once, at the
 * authoritative list boundary. A display string is never used as a
 * post-Apply identity fallback. */
export function resolveManagedTagId(
  selectedTag: string | null | undefined,
  managedTags: readonly Pick<ManagedTag, 'id' | 'normalizedName'>[],
): number | null {
  const normalized = normalizeTag(selectedTag)
  if (!normalized) return null
  return managedTags.find((tag) => tag.normalizedName === normalized)?.id ?? null
}

export function captureTagSelection(
  selectedTag: string | null,
  managedTags: readonly Pick<ManagedTag, 'id' | 'normalizedName'>[],
  selectionEpoch: number,
): TagSelectionSnapshot {
  return {
    selectedTag,
    selectedTagId: resolveManagedTagId(selectedTag, managedTags),
    selectionEpoch,
  }
}

function displayForId(id: number | null, managedTags: readonly ManagedTag[]): string | null {
  if (id === null) return null
  return managedTags.find((tag) => tag.id === id)?.displayName ?? null
}

function committedReconciledId(
  snapshot: TagSelectionSnapshot,
  operation: TagOperationRequest,
): number | null {
  const selectedId = snapshot.selectedTagId
  if (selectedId === null) return null

  if (operation.kind === 'rename' && selectedId === operation.sourceTagId) {
    return operation.sourceTagId
  }
  if (operation.kind === 'merge') {
    if (selectedId === operation.sourceTagId || selectedId === operation.destinationTagId) {
      return operation.destinationTagId
    }
  }
  if (operation.kind === 'remove' && selectedId === operation.sourceTagId) {
    return null
  }
  return selectedId
}

function reconciledId(
  snapshot: TagSelectionSnapshot,
  operation: TagOperationRequest,
  result: TagOperationApplyResult,
): number | null {
  const selectedId = snapshot.selectedTagId
  if (selectedId === null) return null

  if (operation.kind === 'rename' && selectedId === operation.sourceTagId) {
    return result.survivorTagId ?? result.sourceTagId
  }
  if (operation.kind === 'merge') {
    if (selectedId === operation.sourceTagId || selectedId === operation.destinationTagId) {
      return result.survivorTagId ?? result.destinationTagId
    }
  }
  if (operation.kind === 'remove' && selectedId === operation.sourceTagId) {
    return null
  }
  return selectedId
}

/**
 * Reconcile only when the user did not change selection during Apply. The
 * epoch is the race detector; elapsed time and display-string equality are
 * deliberately irrelevant.
 */
export function reconcileTagSelection(input: ReconcileTagSelectionInput): string | null {
  if (input.currentSelectionEpoch !== input.snapshot.selectionEpoch) {
    return input.currentSelectedTag
  }

  const id = reconciledId(input.snapshot, input.operation, input.result)
  // An unresolved pre-Apply string must not become attached to a refreshed
  // row merely because that row now has the same display value.
  return displayForId(id, input.managedTags)
}

/**
 * Reconcile a committed operation using only the trusted submitted operation
 * and fresh authoritative tags. This path is deliberately separate from the
 * normal Apply-result reconciliation because a successful response may have
 * failed the reviewed-Preview contract and must not provide identity data.
 */
export function reconcileCommittedTagSelectionFromOperation(
  input: ReconcileCommittedTagSelectionInput,
): string | null {
  if (input.currentSelectionEpoch !== input.snapshot.selectionEpoch) {
    return input.currentSelectedTag
  }

  return displayForId(
    committedReconciledId(input.snapshot, input.operation),
    input.managedTags,
  )
}

function undoSourceId(
  preview: UndoPreview | null | undefined,
  result: UndoApplyResult | null,
): number | null {
  return preview?.sourceBefore?.id ?? result?.sourceTag.id ?? null
}

function undoDestinationId(
  preview: UndoPreview | null | undefined,
  result: UndoApplyResult | null,
): number | null {
  return preview?.destinationAfter?.id ?? result?.destinationTag?.id ?? null
}

function reconciledUndoId(
  snapshot: UndoSelectionSnapshot,
  preview: UndoPreview | null | undefined,
  result: UndoApplyResult | null,
): number | null {
  const selectedId = snapshot.selectedTagId
  if (selectedId === null) return null

  const sourceId = undoSourceId(preview, result)
  if (sourceId !== null && selectedId === sourceId) return sourceId

  // Merge Undo restores the source row but leaves the destination row in
  // place. Stable IDs, rather than the current display strings, distinguish
  // those two valid selection outcomes.
  if ((preview?.kind ?? result?.kind) === 'merge') {
    const destinationId = undoDestinationId(preview, result)
    if (destinationId !== null && selectedId === destinationId) return destinationId
  }

  // Remove Undo and all unrelated selections preserve the same stable ID.
  // displayForId below intentionally returns null when the fresh list cannot
  // prove that the row still exists.
  return selectedId
}

/** Reconcile a trusted, normally committed Undo against fresh managed tags.
 * The preview is used when available; the validated Apply result is the
 * fallback for VaultView's post-commit seam. */
export function reconcileUndoTagSelection(input: ReconcileUndoTagSelectionInput): string | null {
  if (input.currentSelectionEpoch !== input.snapshot.selectionEpoch) {
    return input.currentSelectedTag
  }

  return displayForId(
    reconciledUndoId(input.snapshot, input.preview, input.result),
    input.managedTags,
  )
}

/** Reconcile a committed-but-untrusted Apply response using only the
 * read-only consumed record and fresh tags. Contradictory response identity
 * fields never enter this function. */
export function reconcileCommittedUndoTagSelection(
  input: ReconcileCommittedUndoTagSelectionInput,
): string | null {
  if (input.currentSelectionEpoch !== input.snapshot.selectionEpoch) {
    return input.currentSelectedTag
  }

  const availability = input.availability
  const sourceId = availability.sourceBefore?.id ?? null
  let selectedId = input.snapshot.selectedTagId
  if (selectedId !== null && sourceId !== null && selectedId === sourceId) {
    selectedId = sourceId
  } else if (availability.kind === 'merge') {
    const destinationId = availability.destinationAfter?.id ?? null
    if (selectedId !== null && destinationId !== null && selectedId === destinationId) {
      selectedId = destinationId
    }
  }

  return displayForId(selectedId, input.managedTags)
}
