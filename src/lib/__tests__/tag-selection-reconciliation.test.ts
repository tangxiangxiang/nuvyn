// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  captureTagSelection,
  reconcileCommittedUndoTagSelection,
  reconcileCommittedTagSelectionFromOperation,
  reconcileUndoTagSelection,
  reconcileTagSelection,
  resolveManagedTagId,
} from '../tag-selection-reconciliation'
import type { ManagedTag, TagOperationApplyResult, TagOperationRequest } from '../tag-management-api'
import type { UndoApplyResult, UndoAvailability, UndoPreview } from '../tag-undo-api'

const tags: ManagedTag[] = [
  { id: 7, normalizedName: 'java', displayName: 'Java', documentCount: 4 },
  { id: 9, normalizedName: 'backend', displayName: 'Backend', documentCount: 4 },
  { id: 20, normalizedName: 'python', displayName: 'Python', documentCount: 2 },
]
const workTag: ManagedTag = { id: 30, normalizedName: 'work', displayName: 'Work', documentCount: 1 }

const undoAvailability: UndoAvailability = {
  supported: true,
  state: 'available',
  validation: 'safe',
  recordId: 'record-1',
  originalOperationId: 'operation-1',
  originalResultId: 'result-1',
  kind: 'rename',
  displayOnly: false,
  committedAt: 1,
  sourceBefore: { id: 7, normalizedName: 'java', displayName: 'Java' },
  sourceAfter: { id: 7, normalizedName: 'backend', displayName: 'Backend' },
  destinationBefore: null,
  destinationAfter: null,
  affectedCount: 1,
  associationAdds: 0,
  associationRemoves: 0,
  versionUpdateCount: 1,
  reasonCode: null,
}

function undoPreview(overrides: Partial<UndoPreview> = {}): UndoPreview {
  return {
    ...undoAvailability,
    warnings: [],
    sample: [],
    nextCursor: null,
    undoFingerprint: 'a'.repeat(64),
    undoContractVersion: 'tag-undo-fingerprint-v1',
    allowedToApply: true,
    ...overrides,
  }
}

function undoResult(overrides: Partial<UndoApplyResult> = {}): UndoApplyResult {
  return {
    undoRecordId: 'record-1',
    originalOperationId: 'operation-1',
    originalResultId: 'result-1',
    undoOperationId: 'undo-operation-1',
    undoResultId: 'undo-result-1',
    kind: 'rename',
    displayOnly: false,
    sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
    destinationTag: null,
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 0,
    versionUpdateCount: 1,
    committedAt: 2,
    appliedUndoFingerprint: 'a'.repeat(64),
    lifecycle: 'consumed',
    ...overrides,
  }
}

function result(operation: TagOperationRequest, overrides: Partial<TagOperationApplyResult> = {}): TagOperationApplyResult {
  return {
    operationId: 'op',
    resultId: 'op',
    kind: operation.kind,
    operation,
    sourceTagId: operation.sourceTagId,
    destinationTagId: operation.kind === 'merge' ? operation.destinationTagId : null,
    survivorTagId: operation.kind === 'remove' ? null : operation.kind === 'merge' ? operation.destinationTagId : operation.sourceTagId,
    sourceTag: null,
    destinationTag: null,
    survivorTag: null,
    sourceDisplayName: null,
    sourceNormalizedName: null,
    destinationDisplayName: null,
    destinationNormalizedName: null,
    survivorDisplayName: null,
    survivorNormalizedName: null,
    sourceDeleted: operation.kind !== 'rename',
    affectedCount: 1,
    associationAdds: 0,
    associationRemoves: 0,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 0,
    displayOnly: false,
    versionUpdateCount: 1,
    commitTimestamp: 1,
    appliedFingerprint: 'a'.repeat(64),
    ...overrides,
  }
}

describe('tag selection reconciliation', () => {
  it('resolves identity by normalized list value but never by an arbitrary string after Apply', () => {
    expect(resolveManagedTagId(' #JAVA ', tags)).toBe(7)
    expect(resolveManagedTagId('Missing', tags)).toBeNull()
  })

  it('keeps Rename source id selected and follows the fresh survivor display', () => {
    const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Backend' }
    const snapshot = captureTagSelection('Java', tags, 12)
    expect(reconcileTagSelection({
      snapshot,
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 12,
      operation,
      result: result(operation),
      managedTags: [{ ...tags[0]!, displayName: 'Backend' }, tags[1]!, tags[2]!],
    })).toBe('Backend')
  })

  it('keeps the same stable id for Display Rename', () => {
    const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'JAVA' }
    const snapshot = captureTagSelection('Java', tags, 1)
    expect(reconcileTagSelection({
      snapshot,
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 1,
      operation,
      result: result(operation, { displayOnly: true }),
      managedTags: [{ ...tags[0]!, displayName: 'JAVA' }, tags[1]!, tags[2]!],
    })).toBe('JAVA')
  })

  it('maps Merge source and destination selection to the survivor, and Remove to null', () => {
    const merge = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 9 }
    expect(reconcileTagSelection({
      snapshot: captureTagSelection('Java', tags, 1),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 1,
      operation: merge,
      result: result(merge),
      managedTags: tags,
    })).toBe('Backend')
    expect(reconcileTagSelection({
      snapshot: captureTagSelection('Backend', tags, 1),
      currentSelectedTag: 'Backend',
      currentSelectionEpoch: 1,
      operation: merge,
      result: result(merge),
      managedTags: tags,
    })).toBe('Backend')

    const remove = { kind: 'remove' as const, sourceTagId: 7 }
    expect(reconcileTagSelection({
      snapshot: captureTagSelection('Java', tags, 1),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 1,
      operation: remove,
      result: result(remove),
      managedTags: tags.filter((tag) => tag.id !== 7),
    })).toBeNull()
  })

  it('preserves an unrelated stable selection and an actual mid-Apply user change', () => {
    const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Backend' }
    expect(reconcileTagSelection({
      snapshot: captureTagSelection('Python', tags, 12),
      currentSelectedTag: 'Python',
      currentSelectionEpoch: 12,
      operation,
      result: result(operation),
      managedTags: tags,
    })).toBe('Python')

    expect(reconcileTagSelection({
      snapshot: captureTagSelection('Java', tags, 12),
      currentSelectedTag: 'Python',
      currentSelectionEpoch: 13,
      operation,
      result: result(operation),
      managedTags: [{ ...tags[0]!, displayName: 'Backend' }, tags[1]!, tags[2]!],
    })).toBe('Python')
  })

  it('does not attach an unresolved pre-Apply string to a refreshed row by display coincidence', () => {
    const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Backend' }
    expect(reconcileTagSelection({
      snapshot: captureTagSelection('Backend', [tags[0]!], 12),
      currentSelectedTag: 'Backend',
      currentSelectionEpoch: 12,
      operation,
      result: result(operation),
      managedTags: [{ ...tags[0]!, displayName: 'Backend' }],
    })).toBeNull()
  })

  it('reconciles committed Merge source selection from the trusted destination ID', () => {
    const operation = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 20 }
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Java', tags, 4),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 4,
      operation,
      managedTags: tags,
    })).toBe('Python')
  })

  it('preserves a newer selection during committed recovery', () => {
    const operation = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 20 }
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Java', tags, 4),
      currentSelectedTag: 'Work',
      currentSelectionEpoch: 5,
      operation,
      managedTags: tags,
    })).toBe('Work')
  })

  it('reconciles committed Merge destination and unrelated selections by stable ID', () => {
    const operation = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 20 }
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Python', tags, 4),
      currentSelectedTag: 'Python',
      currentSelectionEpoch: 4,
      operation,
      managedTags: tags,
    })).toBe('Python')
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Work', [...tags, workTag], 4),
      currentSelectedTag: 'Work',
      currentSelectionEpoch: 4,
      operation,
      managedTags: [...tags, workTag],
    })).toBe('Work')
  })

  it('fails closed when committed Merge destination or unrelated stable ID is missing', () => {
    const operation = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 20 }
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Java', tags, 4),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 4,
      operation,
      managedTags: tags.filter((tag) => tag.id !== 20),
    })).toBeNull()
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Work', [workTag], 4),
      currentSelectedTag: 'Work',
      currentSelectionEpoch: 4,
      operation,
      managedTags: tags,
    })).toBeNull()
  })

  it('reconciles committed Rename from the fresh source display and ignores the requested name', () => {
    const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Renamed' }
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Java', tags, 4),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 4,
      operation,
      managedTags: [{ ...tags[0]!, displayName: 'Backend' }, tags[1]!, tags[2]!],
    })).toBe('Backend')
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Java', tags, 4),
      currentSelectedTag: 'Work',
      currentSelectionEpoch: 5,
      operation,
      managedTags: [{ ...tags[0]!, displayName: 'Backend' }, tags[1]!, tags[2]!],
    })).toBe('Work')
  })

  it('reconciles committed Remove from the trusted source ID without an Apply result', () => {
    const operation = { kind: 'remove' as const, sourceTagId: 7 }
    const freshTags = tags.filter((tag) => tag.id !== 7)
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Java', tags, 8),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 8,
      operation,
      managedTags: freshTags,
    })).toBeNull()
    expect(reconcileCommittedTagSelectionFromOperation({
      snapshot: captureTagSelection('Python', tags, 8),
      currentSelectedTag: 'Python',
      currentSelectionEpoch: 8,
      operation,
      managedTags: freshTags,
    })).toBe('Python')
  })

  it('reconciles Rename Undo and Display Rename Undo by the original stable source ID', () => {
    const rename = undoPreview()
    expect(reconcileUndoTagSelection({
      snapshot: captureTagSelection('Backend', [{ ...tags[0]!, normalizedName: 'backend', displayName: 'Backend' }, tags[1]!], 1),
      currentSelectedTag: 'Backend',
      currentSelectionEpoch: 1,
      preview: rename,
      result: undoResult(),
      managedTags: tags,
    })).toBe('Java')

    const displayRename = undoPreview({
      displayOnly: true,
      sourceAfter: { id: 7, normalizedName: 'java', displayName: 'JAVA' },
    })
    expect(reconcileCommittedUndoTagSelection({
      snapshot: captureTagSelection('JAVA', [{ ...tags[0]! }], 1),
      currentSelectedTag: 'JAVA',
      currentSelectionEpoch: 1,
      availability: displayRename,
      managedTags: tags,
    })).toBe('Java')
  })

  it('restores Merge source, preserves destination, and preserves unrelated stable selection', () => {
    const merge = undoPreview({
      kind: 'merge',
      sourceBefore: { id: 7, normalizedName: 'java', displayName: 'Java' },
      sourceAfter: null,
      destinationBefore: { id: 9, normalizedName: 'backend', displayName: 'Backend' },
      destinationAfter: { id: 9, normalizedName: 'backend', displayName: 'Backend' },
    })
    const mergeResult = undoResult({
      kind: 'merge',
      sourceTag: merge.sourceBefore!,
      destinationTag: merge.destinationAfter,
    })
    const fresh = [tags[0]!, tags[1]!, { id: 9, normalizedName: 'backend', displayName: 'Backend', documentCount: 1 }]
    expect(reconcileUndoTagSelection({
      snapshot: captureTagSelection('Java', tags, 1),
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 1,
      preview: merge,
      result: mergeResult,
      managedTags: fresh,
    })).toBe('Java')
    expect(reconcileUndoTagSelection({
      snapshot: captureTagSelection('Backend', fresh, 1),
      currentSelectedTag: 'Backend',
      currentSelectionEpoch: 1,
      preview: merge,
      result: mergeResult,
      managedTags: fresh,
    })).toBe('Backend')
    expect(reconcileUndoTagSelection({
      snapshot: captureTagSelection('Python', tags, 1),
      currentSelectedTag: 'Python',
      currentSelectionEpoch: 1,
      preview: merge,
      result: mergeResult,
      managedTags: tags,
    })).toBe('Python')
  })

  it('restores Remove source only when the stable ID was resolved, never by display coincidence', () => {
    const remove = undoPreview({
      kind: 'remove',
      sourceBefore: { id: 7, normalizedName: 'java', displayName: 'Java' },
      sourceAfter: null,
      destinationBefore: null,
      destinationAfter: null,
    })
    const result = undoResult({ kind: 'remove', sourceTag: remove.sourceBefore! })
    const restored = [...tags]
    expect(reconcileUndoTagSelection({
      snapshot: { selectedTag: 'Java', selectedTagId: 7, selectionEpoch: 1 },
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 1,
      preview: remove,
      result,
      managedTags: restored,
    })).toBe('Java')
    expect(reconcileUndoTagSelection({
      snapshot: { selectedTag: 'Java', selectedTagId: null, selectionEpoch: 1 },
      currentSelectedTag: 'Java',
      currentSelectionEpoch: 1,
      preview: remove,
      result,
      managedTags: restored,
    })).toBeNull()
  })

  it('lets a newer user selection win and fails closed when the expected stable ID is absent', () => {
    const preview = undoPreview()
    const result = undoResult()
    expect(reconcileUndoTagSelection({
      snapshot: captureTagSelection('Backend', [{ ...tags[0]!, normalizedName: 'backend' }], 4),
      currentSelectedTag: 'Python',
      currentSelectionEpoch: 5,
      preview,
      result,
      managedTags: tags,
    })).toBe('Python')
    expect(reconcileUndoTagSelection({
      snapshot: { selectedTag: 'Backend', selectedTagId: 7, selectionEpoch: 4 },
      currentSelectedTag: 'Backend',
      currentSelectionEpoch: 4,
      preview,
      result,
      managedTags: tags.filter((tag) => tag.id !== 7),
    })).toBeNull()
  })

  it('ignores contradictory Apply identity during committed recovery', () => {
    const consumed = {
      ...undoAvailability,
      state: 'consumed' as const,
      validation: 'terminal-unavailable' as const,
      reasonCode: 'UNDO_ALREADY_APPLIED',
      sourceBefore: { id: 7, normalizedName: 'java', displayName: 'Java' },
      sourceAfter: { id: 7, normalizedName: 'backend', displayName: 'Backend' },
    }
    const contradictory = undoResult({
      sourceTag: { id: 999, normalizedName: 'wrong', displayName: 'Wrong' },
    })
    expect(contradictory.sourceTag.id).toBe(999)
    expect(reconcileCommittedUndoTagSelection({
      snapshot: { selectedTag: 'Backend', selectedTagId: 7, selectionEpoch: 1 },
      currentSelectedTag: 'Backend',
      currentSelectionEpoch: 1,
      availability: consumed,
      managedTags: tags,
    })).toBe('Java')
  })
})
