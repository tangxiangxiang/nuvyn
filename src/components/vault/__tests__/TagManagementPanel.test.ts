// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import { useI18n } from '../../../composables/useI18n'
import TagManagementPanel from '../TagManagementPanel.vue'
import type {
  ManagedTag,
  TagOperationApplyResult,
  TagOperationPreview,
  TagOperationRequest,
} from '../../../lib/tag-management-api'
import {
  reconcileCommittedTagSelectionFromOperation,
  reconcileTagSelection,
  type TagSelectionSnapshot,
} from '../../../lib/tag-selection-reconciliation'
import type {
  UndoApplyResult,
  UndoAvailability,
  UndoPreview,
} from '../../../lib/tag-undo-api'

const mocks = vi.hoisted(() => ({
  listManagedTags: vi.fn(),
  previewTagOperation: vi.fn(),
  getTagOperationPreviewPage: vi.fn(),
  applyTagOperation: vi.fn(),
  assertApplyResultMatchesReviewedPreview: vi.fn(),
  getUndoAvailability: vi.fn(),
  previewUndo: vi.fn(),
  getUndoPreviewPage: vi.fn(),
  applyUndo: vi.fn(),
  recoverCommittedUndo: vi.fn(),
  confirmCancellable: vi.fn(),
  TagManagementApiError: class extends Error {
    readonly status: number
    readonly code: string
    constructor(message: string, status: number, code: string) {
      super(message)
      this.name = 'TagManagementApiError'
      this.status = status
      this.code = code
    }
  },
  TagUndoApiError: class extends Error {
    readonly status: number
    readonly code: string
    readonly recoveryRecordId: string | null
    constructor(message: string, status: number, code: string, recoveryRecordId: string | null = null) {
      super(message)
      this.name = 'TagUndoApiError'
      this.status = status
      this.code = code
      this.recoveryRecordId = recoveryRecordId
    }
  },
}))

vi.mock('../../../lib/tag-management-api', () => mocks)
vi.mock('../../../lib/tag-undo-api', () => mocks)
vi.mock('../../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirmCancellable: mocks.confirmCancellable }),
}))

const TAGS: ManagedTag[] = [
  { id: 7, normalizedName: 'java', displayName: 'Java', documentCount: 3 },
  { id: 20, normalizedName: 'python', displayName: 'Python', documentCount: 2 },
]
const RENAMED_TAGS: ManagedTag[] = [
  { id: 7, normalizedName: 'backend', displayName: 'Backend', documentCount: 3 },
  TAGS[1]!,
]
const operation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Backend' }
const mergeOperation = { kind: 'merge' as const, sourceTagId: 7, destinationTagId: 20 }
const mergeDestination = { id: 20, normalizedName: 'python', displayName: 'Python' }
const removeOperation = { kind: 'remove' as const, sourceTagId: 7 }

function makePreview(overrides: Partial<TagOperationPreview> = {}): TagOperationPreview {
  return {
    operation,
    sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
    destinationTag: null,
    requestedDestination: { displayName: 'Backend', normalizedName: 'backend' },
    survivorTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
    displayOnly: false,
    affectedCount: 3,
    associationAdds: 0,
    associationRemoves: 0,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 0,
    warnings: [],
    allowedToApply: true,
    planFingerprint: 'a'.repeat(64),
    healthContractVersion: 'tag-identity-v1',
    sample: [{ id: 'doc-1', path: 'inbox/one', title: 'One' }],
    nextAfterDocumentId: null,
    ...overrides,
  }
}

function makeResult(overrides: Partial<TagOperationApplyResult> = {}): TagOperationApplyResult {
  return {
    operationId: 'operation-1',
    resultId: 'operation-1',
    kind: 'rename',
    operation,
    sourceTagId: 7,
    destinationTagId: null,
    survivorTagId: 7,
    sourceTag: { id: 7, normalizedName: 'backend', displayName: 'Backend' },
    destinationTag: null,
    survivorTag: { id: 7, normalizedName: 'backend', displayName: 'Backend' },
    sourceDisplayName: 'Backend',
    sourceNormalizedName: 'backend',
    destinationDisplayName: null,
    destinationNormalizedName: null,
    survivorDisplayName: 'Backend',
    survivorNormalizedName: 'backend',
    sourceDeleted: false,
    affectedCount: 3,
    associationAdds: 0,
    associationRemoves: 0,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 0,
    displayOnly: false,
    versionUpdateCount: 3,
    commitTimestamp: 1_700_000_000_000,
    appliedFingerprint: 'a'.repeat(64),
    ...overrides,
  }
}

function makeMergePreview(overrides: Partial<TagOperationPreview> = {}): TagOperationPreview {
  return makePreview({
    operation: mergeOperation,
    sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
    destinationTag: mergeDestination,
    requestedDestination: null,
    survivorTag: mergeDestination,
    displayOnly: false,
    affectedCount: 3,
    associationAdds: 2,
    associationRemoves: 3,
    duplicateCollapses: 1,
    tagCreates: 0,
    tagDeletes: 1,
    warnings: ['DESTRUCTIVE'],
    ...overrides,
  })
}

function makeMergeResult(overrides: Partial<TagOperationApplyResult> = {}): TagOperationApplyResult {
  return {
    operationId: 'merge-operation-1',
    resultId: 'merge-operation-1',
    kind: 'merge',
    operation: mergeOperation,
    sourceTagId: 7,
    destinationTagId: 20,
    survivorTagId: 20,
    sourceTag: null,
    destinationTag: mergeDestination,
    survivorTag: mergeDestination,
    sourceDisplayName: null,
    sourceNormalizedName: null,
    destinationDisplayName: 'Python',
    destinationNormalizedName: 'python',
    survivorDisplayName: 'Python',
    survivorNormalizedName: 'python',
    sourceDeleted: true,
    affectedCount: 3,
    associationAdds: 2,
    associationRemoves: 3,
    duplicateCollapses: 1,
    tagCreates: 0,
    tagDeletes: 1,
    displayOnly: false,
    versionUpdateCount: 3,
    commitTimestamp: 1_700_000_000_000,
    appliedFingerprint: 'a'.repeat(64),
    ...overrides,
  }
}

function makeRemovePreview(overrides: Partial<TagOperationPreview> = {}): TagOperationPreview {
  return makePreview({
    operation: removeOperation,
    sourceTag: { id: 7, normalizedName: 'java', displayName: 'Java' },
    destinationTag: null,
    requestedDestination: null,
    survivorTag: null,
    displayOnly: false,
    affectedCount: 3,
    associationAdds: 0,
    associationRemoves: 3,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 1,
    warnings: ['DESTRUCTIVE'],
    ...overrides,
  })
}

function makeRemoveResult(overrides: Partial<TagOperationApplyResult> = {}): TagOperationApplyResult {
  return {
    operationId: 'remove-operation-1',
    resultId: 'remove-operation-1',
    kind: 'remove',
    operation: removeOperation,
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
    affectedCount: 3,
    associationAdds: 0,
    associationRemoves: 3,
    duplicateCollapses: 0,
    tagCreates: 0,
    tagDeletes: 1,
    displayOnly: false,
    versionUpdateCount: 3,
    commitTimestamp: 1_700_000_000_000,
    appliedFingerprint: 'a'.repeat(64),
    ...overrides,
  }
}

const undoRecordId = 'undo-record-1'
const latestUndoRecordId = 'undo-record-2'
const undoFingerprint = 'b'.repeat(64)
const latestUndoFingerprint = 'c'.repeat(64)
const undoSourceBefore = { id: 7, normalizedName: 'java', displayName: 'Java' }
const undoSourceAfter = { id: 7, normalizedName: 'backend', displayName: 'Backend' }
const undoDestination = { id: 20, normalizedName: 'python', displayName: 'Python' }

function makeUndoAvailability(overrides: Partial<UndoAvailability> = {}): UndoAvailability {
  return {
    supported: true,
    state: 'available',
    validation: 'safe',
    recordId: undoRecordId,
    originalOperationId: 'original-operation-1',
    originalResultId: 'original-result-1',
    kind: 'rename',
    displayOnly: false,
    committedAt: 1_700_000_000_000,
    sourceBefore: undoSourceBefore,
    sourceAfter: undoSourceAfter,
    destinationBefore: null,
    destinationAfter: null,
    affectedCount: 3,
    associationAdds: 0,
    associationRemoves: 0,
    versionUpdateCount: 3,
    reasonCode: null,
    ...overrides,
  }
}

function makeLatestUndoAvailability(overrides: Partial<UndoAvailability> = {}): UndoAvailability {
  return makeUndoAvailability({
    recordId: latestUndoRecordId,
    originalOperationId: 'original-operation-2',
    originalResultId: 'original-result-2',
    sourceBefore: { id: 20, normalizedName: 'python', displayName: 'Python' },
    sourceAfter: { id: 20, normalizedName: 'rust', displayName: 'Rust' },
    committedAt: 1_700_000_001_000,
    ...overrides,
  })
}

function makeUndoPreview(overrides: Partial<UndoPreview> = {}): UndoPreview {
  return {
    ...makeUndoAvailability(),
    warnings: [],
    sample: [{ id: 'doc-undo-1', path: 'inbox/undo-one', title: 'Undo One' }],
    nextCursor: null,
    undoFingerprint,
    undoContractVersion: 'tag-undo-fingerprint-v1',
    allowedToApply: true,
    ...overrides,
  }
}

function makeSupersededUndoPreview(overrides: Partial<UndoPreview> = {}): UndoPreview {
  return makeUndoPreview({
    state: 'superseded',
    validation: 'terminal-unavailable',
    recordId: null,
    originalOperationId: null,
    originalResultId: null,
    kind: null,
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
    warnings: [],
    sample: [],
    nextCursor: null,
    undoFingerprint: null,
    allowedToApply: false,
    ...overrides,
  })
}

function makeUndoResult(overrides: Partial<UndoApplyResult> = {}): UndoApplyResult {
  return {
    undoRecordId,
    originalOperationId: 'original-operation-1',
    originalResultId: 'original-result-1',
    undoOperationId: 'undo-operation-1',
    undoResultId: 'undo-result-1',
    kind: 'rename',
    displayOnly: false,
    sourceTag: undoSourceBefore,
    destinationTag: null,
    affectedCount: 3,
    associationAdds: 0,
    associationRemoves: 0,
    versionUpdateCount: 3,
    committedAt: 1_700_000_000_100,
    appliedUndoFingerprint: undoFingerprint,
    lifecycle: 'consumed',
    ...overrides,
  }
}

function mountPanel(options: {
  selectedTag?: string | null
  selectionEpoch?: number
  refreshPosts?: () => void | Promise<void>
  syncAfterCommit?: (
    result: TagOperationApplyResult,
    snapshot: TagSelectionSnapshot,
  ) => Promise<{ managedTags: ManagedTag[]; selectedTag: string | null }>
  recoverCommittedOperation?: (
    operation: TagOperationRequest,
    snapshot: TagSelectionSnapshot,
  ) => Promise<{ managedTags: ManagedTag[]; selectedTag: string | null }>
  syncAfterUndo?: (
    result: UndoApplyResult,
    snapshot: TagSelectionSnapshot,
  ) => Promise<{
    managedTags: ManagedTag[]
    selectedTag: string | null
    undoAvailability: UndoAvailability
  }>
  recoverCommittedUndo?: (
    recordId: string,
    snapshot: TagSelectionSnapshot,
  ) => Promise<{
    managedTags: ManagedTag[]
    selectedTag: string | null
    undoAvailability: UndoAvailability
    outcome: 'consumed' | 'superseded' | 'terminal-unavailable'
  }>
} = {}): VueWrapper {
  const syncAfterCommit = options.syncAfterCommit ?? (async (
    result: TagOperationApplyResult,
    snapshot: TagSelectionSnapshot,
  ) => {
    const [, tags] = await Promise.all([
      options.refreshPosts?.(),
      mocks.listManagedTags(),
    ])
    const managedTags = tags as ManagedTag[]
    return {
      managedTags,
      selectedTag: reconcileTagSelection({
        snapshot,
        currentSelectedTag: options.selectedTag ?? null,
        currentSelectionEpoch: options.selectionEpoch ?? 0,
        operation: result.operation,
        result,
        managedTags,
      }),
    }
  })
  const recoverCommittedOperation = options.recoverCommittedOperation ?? (async (
    submittedOperation: TagOperationRequest,
    snapshot: TagSelectionSnapshot,
  ) => {
    const managedTags = await mocks.listManagedTags() as ManagedTag[]
    return {
      managedTags,
      selectedTag: reconcileCommittedTagSelectionFromOperation({
        snapshot,
        currentSelectedTag: options.selectedTag ?? null,
        currentSelectionEpoch: options.selectionEpoch ?? 0,
        operation: submittedOperation,
        managedTags,
      }),
    }
  })
  return mount(TagManagementPanel, {
    attachTo: document.body,
    props: {
      selectedTag: options.selectedTag ?? null,
      selectionEpoch: options.selectionEpoch ?? 0,
      syncAfterCommit,
      recoverCommittedOperation,
      ...(options.syncAfterUndo ? { syncAfterUndo: options.syncAfterUndo } : {}),
      ...(options.recoverCommittedUndo ? { recoverCommittedUndo: options.recoverCommittedUndo } : {}),
    },
  })
}

async function settle(): Promise<void> {
  await flushPromises()
  await flushPromises()
}

async function setTagSelect(wrapper: VueWrapper, id: string, value: string): Promise<void> {
  const select = getTagSelect(wrapper, id)
  await select.vm.$emit('update:value', value === '' ? null : value)
  await settle()
}

function getTagSelect(wrapper: VueWrapper, id: string) {
  const select = wrapper.findAllComponents(NSelect).find((candidate) => candidate.attributes('id') === id)
  if (!select) throw new Error(`Naive select not found: ${id}`)
  return select
}

function selectedTagSelectValue(wrapper: VueWrapper, id: string): string {
  const value = getTagSelect(wrapper, id).props('value')
  return value === null || value === undefined ? '' : String(value)
}

function tagSelectOptionValues(wrapper: VueWrapper, id: string): string[] {
  const options = getTagSelect(wrapper, id).props('options') as Array<{ value?: string | number }>
  return options.map((option) => String(option.value ?? ''))
}

function resolveRemovalConfirmation(value: boolean): void {
  mocks.confirmCancellable.mockReturnValueOnce({
    promise: Promise.resolve(value),
    cancel: vi.fn(),
  })
}

function resolveUndoConfirmation(value: boolean): void {
  mocks.confirmCancellable.mockReturnValueOnce({
    promise: Promise.resolve(value),
    cancel: vi.fn(),
  })
}

function pendingRemovalConfirmation(): { resolve: (value: boolean) => void; cancel: ReturnType<typeof vi.fn> } {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((next) => { resolve = next })
  const cancel = vi.fn(() => resolve(false))
  mocks.confirmCancellable.mockReturnValueOnce({ promise, cancel })
  return { resolve, cancel }
}

function pendingUndoConfirmation(): { resolve: (value: boolean) => void; cancel: ReturnType<typeof vi.fn> } {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((next) => { resolve = next })
  const cancel = vi.fn(() => resolve(false))
  mocks.confirmCancellable.mockReturnValueOnce({ promise, cancel })
  return { resolve, cancel }
}

function enableUndoAvailability(overrides: Partial<UndoAvailability> = {}): void {
  mocks.getUndoAvailability.mockReset().mockResolvedValue(makeUndoAvailability(overrides))
}

describe('TagManagementPanel', () => {
  let wrappers: VueWrapper[] = []

  beforeEach(() => {
    useI18n().setLocale('en')
    mocks.listManagedTags.mockReset().mockResolvedValue(TAGS)
    mocks.previewTagOperation.mockReset().mockResolvedValue(makePreview())
    mocks.getTagOperationPreviewPage.mockReset().mockResolvedValue(makePreview({
      sample: [{ id: 'doc-2', path: 'inbox/two', title: 'Two' }],
      nextAfterDocumentId: 'doc-2',
    }))
    mocks.applyTagOperation.mockReset().mockResolvedValue(makeResult())
    mocks.assertApplyResultMatchesReviewedPreview.mockReset()
    mocks.getUndoAvailability.mockReset().mockRejectedValue(new mocks.TagUndoApiError('old server', 404, 'UNDO_UNAVAILABLE'))
    mocks.previewUndo.mockReset().mockResolvedValue(makeUndoPreview())
    mocks.getUndoPreviewPage.mockReset().mockResolvedValue(makeUndoPreview({
      sample: [{ id: 'doc-undo-2', path: 'inbox/undo-two', title: 'Undo Two' }],
      nextCursor: null,
    }))
    mocks.applyUndo.mockReset().mockResolvedValue(makeUndoResult())
    mocks.recoverCommittedUndo.mockReset()
    mocks.confirmCancellable.mockReset()
  })

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount()
    wrappers = []
    document.body.innerHTML = ''
    useI18n().setLocale('zh')
  })

  function mountTracked(options: Parameters<typeof mountPanel>[0] = {}): VueWrapper {
    const wrapper = mountPanel(options)
    wrappers.push(wrapper)
    return wrapper
  }

  it('loads the authoritative stable-ID list and exposes all three operations', async () => {
    const wrapper = mountTracked()
    await settle()
    expect(mocks.listManagedTags).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('ready')
    expect(tagSelectOptionValues(wrapper, 'tag-management-source')).toHaveLength(3)
    expect(wrapper.find('.tag-management-header').exists()).toBe(false)
    expect(wrapper.get('[data-tag-management-panel]').attributes('aria-labelledby')).toBe('settings-tags-title')
    expect(wrapper.get('[data-tag-management-panel]').attributes('aria-label')).toBe('Tags')
    expect(wrapper.find('[data-operation="remove"]').exists()).toBe(true)
    expect(wrapper.find('[data-operation="merge"]').exists()).toBe(true)
  })

  it('hides Undo when authoritative availability is unavailable', async () => {
    const wrapper = mountTracked()
    await settle()
    expect(mocks.getUndoAvailability).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-undo-last-change]').exists()).toBe(false)
  })

  it('does not expose Preview while availability is temporarily unavailable', async () => {
    enableUndoAvailability({ validation: 'temporary-unavailable' })
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-unavailable')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-undo-last-change]').exists()).toBe(false)
  })

  it('renders an authoritative Last Change and requires Preview before Undo Apply', async () => {
    enableUndoAvailability()
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Last change')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Undo Rename')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Java')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Backend')
    expect(wrapper.find('[data-action="undo-apply"]').exists()).toBe(false)
    expect(mocks.applyUndo).not.toHaveBeenCalled()

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenCalledWith(undoRecordId, 20)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-preview-ready')
    expect(wrapper.get('[data-undo-preview]').text()).toContain('Undo Preview ready')
    expect(wrapper.get('[data-undo-preview]').text()).toContain('Documents and Markdown content are preserved')
    expect(wrapper.get('[data-undo-preview]').text()).toContain('Undo One')
  })

  it('keeps Display Rename visibly distinct in Last Change and Preview', async () => {
    enableUndoAvailability({
      displayOnly: true,
      sourceAfter: { id: 7, normalizedName: 'java', displayName: 'JAVA' },
    })
    mocks.previewUndo.mockResolvedValueOnce(makeUndoPreview({
      displayOnly: true,
      sourceAfter: { id: 7, normalizedName: 'java', displayName: 'JAVA' },
    }))
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Undo Display Rename')
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-undo-preview]').text()).toContain('Undo Display Rename')
    expect(wrapper.get('[data-undo-preview]').text()).not.toContain('Undo Rename')
  })

  it('renders bounded Merge and Remove Undo summaries and warning meanings', async () => {
    enableUndoAvailability({
      kind: 'merge',
      sourceBefore: undoSourceBefore,
      sourceAfter: null,
      destinationBefore: undoDestination,
      destinationAfter: undoDestination,
      associationAdds: 2,
      associationRemoves: 3,
      versionUpdateCount: 4,
    })
    mocks.previewUndo.mockResolvedValueOnce(makeUndoPreview({
      kind: 'merge',
      sourceBefore: undoSourceBefore,
      sourceAfter: null,
      destinationBefore: undoDestination,
      destinationAfter: undoDestination,
      associationAdds: 2,
      associationRemoves: 3,
      versionUpdateCount: 4,
      warnings: ['DESTRUCTIVE', 'HIGH_IMPACT', 'DYNAMIC_CONFLICT'],
    }))
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Undo Merge')
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    const text = wrapper.get('[data-undo-preview]').text()
    expect(text).toContain('Undo Merge')
    expect(text).toContain('Destructive impact')
    expect(text).toContain('High impact')
    expect(text).toContain('Current-state conflict')

    enableUndoAvailability({
      kind: 'remove',
      sourceBefore: undoSourceBefore,
      sourceAfter: null,
      destinationBefore: null,
      destinationAfter: null,
      associationRemoves: 3,
    })
    wrapper.unmount()
    const remounted = mountTracked()
    await settle()
    expect(remounted.get('[data-undo-last-change]').text()).toContain('Undo Remove')
  })

  it('uses ConfirmHost semantics, keeps Preview after Cancel, and Applies Undo once on confirmation', async () => {
    enableUndoAvailability()
    const undoAvailabilityAfterCommit = makeUndoAvailability({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
    })
    const syncAfterUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: undoAvailabilityAfterCommit,
    }))
    const wrapper = mountTracked({ selectedTag: 'Backend', selectionEpoch: 7, syncAfterUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()

    const cancel = pendingUndoConfirmation()
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-confirming')
    expect(mocks.confirmCancellable).toHaveBeenLastCalledWith(
      'Confirm Undo Rename?',
      expect.stringContaining('Document content, Markdown, and Git History are not rolled back'),
      expect.objectContaining({
        cancelLabel: 'Cancel',
        confirmLabel: 'Confirm Undo',
        destructive: true,
      }),
    )
    cancel.resolve(false)
    await settle()
    expect(mocks.applyUndo).not.toHaveBeenCalled()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-preview-ready')
    expect(wrapper.find('[data-undo-preview]').exists()).toBe(true)

    const confirm = pendingUndoConfirmation()
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()
    confirm.resolve(true)
    await settle()
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(mocks.applyUndo).toHaveBeenCalledWith(expect.objectContaining({
      recordId: undoRecordId,
      undoFingerprint,
    }))
    expect(syncAfterUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-success')
    expect(wrapper.get('.tag-management-live').text()).toContain('Undo successful')
  })

  it('keeps fresh R2 actionable after successful Undo R1 synchronization', async () => {
    const latestAvailability = makeLatestUndoAvailability()
    enableUndoAvailability()
    mocks.previewUndo
      .mockReset()
      .mockResolvedValueOnce(makeUndoPreview())
      .mockResolvedValueOnce(makeUndoPreview({
        ...latestAvailability,
        undoFingerprint: latestUndoFingerprint,
      }))
    const syncAfterUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: latestAvailability,
    }))
    const wrapper = mountTracked({ syncAfterUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()

    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(syncAfterUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Rust')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(true)
    expect(wrapper.find('[data-undo-preview]').exists()).toBe(false)
    expect(wrapper.find('[data-tag-management-panel]').exists()).toBe(true)

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenCalledTimes(2)
    expect(mocks.previewUndo).toHaveBeenLastCalledWith(latestUndoRecordId, 20)
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
  })

  it('maps conflict and stale Apply failures without a second Apply', async () => {
    enableUndoAvailability()
    mocks.applyUndo.mockRejectedValueOnce(new mocks.TagUndoApiError('conflict', 409, 'UNDO_CONFLICT'))
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-conflict')
    expect(wrapper.find('[data-action="undo-apply"]').exists()).toBe(false)

    enableUndoAvailability()
    mocks.previewUndo.mockRejectedValueOnce(new mocks.TagUndoApiError('stale', 409, 'UNDO_STALE'))
    wrapper.unmount()
    const remounted = mountTracked()
    await settle()
    await remounted.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(remounted.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-stale')
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
  })

  it('recovers a malformed committed response with READ only and never Applies again', async () => {
    enableUndoAvailability()
    const recoveredAvailability = makeUndoAvailability({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
    })
    mocks.applyUndo.mockRejectedValueOnce(new mocks.TagUndoApiError(
      'invalid committed response',
      200,
      'CLIENT_PROTOCOL_ERROR',
      undoRecordId,
    ))
    const recoverCommittedUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: recoveredAvailability,
      outcome: 'consumed' as const,
    }))
    const wrapper = mountTracked({ recoverCommittedUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(recoverCommittedUndo).toHaveBeenCalledWith(undoRecordId, expect.objectContaining({ selectionEpoch: 0 }))
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-success')
    expect(wrapper.find('[data-action="undo-retry-sync"]').exists()).toBe(false)
  })

  it('keeps fresh R2 actionable after consumed recovery of Undo R1', async () => {
    const latestAvailability = makeLatestUndoAvailability()
    enableUndoAvailability()
    mocks.previewUndo
      .mockReset()
      .mockResolvedValueOnce(makeUndoPreview())
      .mockResolvedValueOnce(makeUndoPreview({
        ...latestAvailability,
        undoFingerprint: latestUndoFingerprint,
      }))
    mocks.applyUndo.mockRejectedValueOnce(new mocks.TagUndoApiError(
      'invalid committed response',
      200,
      'CLIENT_PROTOCOL_ERROR',
      undoRecordId,
    ))
    const recoverCommittedUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: latestAvailability,
      outcome: 'consumed' as const,
    }))
    const wrapper = mountTracked({ recoverCommittedUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()

    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(recoverCommittedUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Rust')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(true)

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenLastCalledWith(latestUndoRecordId, 20)
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
  })

  it('keeps fresh R2 actionable after terminal recovery of Undo R1', async () => {
    const latestAvailability = makeLatestUndoAvailability()
    enableUndoAvailability()
    mocks.previewUndo
      .mockReset()
      .mockResolvedValueOnce(makeUndoPreview())
      .mockResolvedValueOnce(makeUndoPreview({
        ...latestAvailability,
        undoFingerprint: latestUndoFingerprint,
      }))
    mocks.applyUndo.mockRejectedValueOnce(new mocks.TagUndoApiError(
      'invalid committed response',
      200,
      'CLIENT_PROTOCOL_ERROR',
      undoRecordId,
    ))
    const recoverCommittedUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: latestAvailability,
      outcome: 'terminal-unavailable' as const,
    }))
    const wrapper = mountTracked({ recoverCommittedUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()

    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(recoverCommittedUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.get('[data-undo-last-change]').text()).toContain('Rust')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(true)

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenLastCalledWith(latestUndoRecordId, 20)
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
  })

  it('preserves a current terminal availability after terminal recovery', async () => {
    const terminalAvailability = makeUndoAvailability({
      state: 'terminal-unavailable',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_RECORD_CORRUPT',
    })
    enableUndoAvailability()
    mocks.applyUndo.mockRejectedValueOnce(new mocks.TagUndoApiError(
      'invalid committed response',
      200,
      'CLIENT_PROTOCOL_ERROR',
      undoRecordId,
    ))
    const recoverCommittedUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: terminalAvailability,
      outcome: 'terminal-unavailable' as const,
    }))
    const wrapper = mountTracked({ recoverCommittedUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()

    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(recoverCommittedUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-terminal-unavailable')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(false)
  })

  it('enters sync-pending after a known commit and retries synchronization only', async () => {
    enableUndoAvailability()
    let attempts = 0
    const syncAfterUndo = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('refresh failed')
      return {
        managedTags: RENAMED_TAGS,
        selectedTag: 'Backend',
        undoAvailability: makeUndoAvailability({
          state: 'consumed',
          validation: 'terminal-unavailable',
          reasonCode: 'UNDO_ALREADY_APPLIED',
        }),
      }
    })
    const wrapper = mountTracked({ syncAfterUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-sync-pending')
    expect(wrapper.get('[data-action="undo-retry-sync"]').text()).toBe('Retry synchronization')
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-action="undo-retry-sync"]').trigger('click')
    await settle()
    expect(syncAfterUndo).toHaveBeenCalledTimes(2)
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-success')
  })

  it('refreshes the latest Undo record when an old Preview is superseded', async () => {
    const record2 = 'undo-record-2'
    const latestAvailability = makeUndoAvailability({ recordId: record2 })
    mocks.getUndoAvailability
      .mockReset()
      .mockResolvedValueOnce(makeUndoAvailability())
      .mockResolvedValueOnce(latestAvailability)
    mocks.previewUndo
      .mockReset()
      .mockResolvedValueOnce(makeSupersededUndoPreview())
      .mockResolvedValueOnce(makeUndoPreview({ recordId: record2 }))

    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()

    expect(mocks.previewUndo).toHaveBeenCalledTimes(1)
    expect(mocks.previewUndo).toHaveBeenCalledWith(undoRecordId, 20)
    expect(mocks.getUndoAvailability).toHaveBeenCalledTimes(2)
    expect(mocks.applyUndo).not.toHaveBeenCalled()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.find('[data-undo-last-change]').exists()).toBe(true)
    expect(wrapper.get('[data-action="undo-preview"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenCalledTimes(2)
    expect(mocks.previewUndo).toHaveBeenLastCalledWith(record2, 20)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-preview-ready')
  })

  it('refreshes the latest Undo record after an UNDO_SUPERSEDED Preview error', async () => {
    const record2 = 'undo-record-2'
    mocks.getUndoAvailability
      .mockReset()
      .mockResolvedValueOnce(makeUndoAvailability())
      .mockResolvedValueOnce(makeUndoAvailability({ recordId: record2 }))
    mocks.previewUndo
      .mockReset()
      .mockRejectedValueOnce(new mocks.TagUndoApiError('superseded', 409, 'UNDO_SUPERSEDED'))
      .mockResolvedValueOnce(makeUndoPreview({ recordId: record2 }))

    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()

    expect(mocks.previewUndo).toHaveBeenCalledTimes(1)
    expect(mocks.applyUndo).not.toHaveBeenCalled()
    expect(wrapper.find('[data-undo-preview]').exists()).toBe(false)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(true)

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenLastCalledWith(record2, 20)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-preview-ready')
  })

  it('adopts the latest Undo availability after superseded committed recovery', async () => {
    const record2 = 'undo-record-2'
    const latestAvailability = makeUndoAvailability({ recordId: record2 })
    enableUndoAvailability()
    mocks.previewUndo
      .mockReset()
      .mockResolvedValueOnce(makeUndoPreview())
      .mockResolvedValueOnce(makeUndoPreview({ recordId: record2 }))
    mocks.applyUndo.mockRejectedValueOnce(new mocks.TagUndoApiError(
      'invalid committed response',
      200,
      'CLIENT_PROTOCOL_ERROR',
      undoRecordId,
    ))
    const recoverCommittedUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: latestAvailability,
      outcome: 'superseded' as const,
    }))

    const wrapper = mountTracked({ recoverCommittedUndo })
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()

    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(recoverCommittedUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-available')
    expect(wrapper.find('[data-undo-preview]').exists()).toBe(false)
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(true)

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(mocks.previewUndo).toHaveBeenLastCalledWith(record2, 20)
  })

  it('keeps a fresh consumed Undo availability terminal', async () => {
    enableUndoAvailability({
      state: 'consumed',
      validation: 'terminal-unavailable',
      reasonCode: 'UNDO_ALREADY_APPLIED',
    })
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-terminal-unavailable')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="undo-apply"]').exists()).toBe(false)
  })

  it('invalidates ordinary Preview before Undo and leaves no stale ordinary Apply after Undo', async () => {
    enableUndoAvailability()
    const syncAfterUndo = vi.fn(async () => ({
      managedTags: RENAMED_TAGS,
      selectedTag: 'Backend',
      undoAvailability: makeUndoAvailability({
        state: 'consumed',
        validation: 'terminal-unavailable',
        reasonCode: 'UNDO_ALREADY_APPLIED',
      }),
    }))
    const wrapper = mountTracked({ syncAfterUndo })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.get('.tag-management-preview [data-action="apply"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(wrapper.find('[data-action="apply"]').exists()).toBe(false)
    expect(wrapper.find('[data-undo-preview]').exists()).toBe(true)

    resolveUndoConfirmation(true)
    await wrapper.get('[data-action="undo-apply"]').trigger('click')
    await settle()
    expect(mocks.applyUndo).toHaveBeenCalledTimes(1)
    expect(syncAfterUndo).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(wrapper.find('[data-action="apply"]').exists()).toBe(false)
    expect(wrapper.get('[data-undo-state]').attributes('data-undo-state')).toBe('undo-success')
  })

  it('disables Undo while ordinary Apply is in flight', async () => {
    enableUndoAvailability()
    let resolveApply!: (result: TagOperationApplyResult) => void
    mocks.applyTagOperation.mockImplementationOnce(() => new Promise<TagOperationApplyResult>((resolve) => {
      resolveApply = resolve
    }))
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview [data-action="apply"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('applying')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(false)
    expect(mocks.previewUndo).not.toHaveBeenCalled()
    expect(mocks.applyUndo).not.toHaveBeenCalled()

    resolveApply(makeResult())
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('success')
  })

  it('disables Undo while ordinary synchronization is sync-pending', async () => {
    enableUndoAvailability()
    const syncAfterCommit = vi.fn(async () => {
      throw new Error('sync unavailable')
    })
    const wrapper = mountTracked({ syncAfterCommit })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview [data-action="apply"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    expect(wrapper.get('.tag-management-state-error .primary').text()).toBe('Retry synchronization')
    expect(wrapper.find('[data-action="undo-preview"]').exists()).toBe(false)
    expect(mocks.previewUndo).not.toHaveBeenCalled()
    expect(mocks.applyUndo).not.toHaveBeenCalled()
  })

  it('clears an Undo Preview when the user starts an ordinary operation', async () => {
    enableUndoAvailability()
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-action="undo-preview"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-undo-preview]').exists()).toBe(true)

    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.find('[data-undo-preview]').exists()).toBe(false)
    expect(wrapper.find('[data-action="undo-apply"]').exists()).toBe(false)
    expect(wrapper.find('.tag-management-preview').exists()).toBe(true)
    expect(mocks.applyUndo).not.toHaveBeenCalled()
  })

  it('renders a safe unavailable state and makes Preview/Apply impossible', async () => {
    mocks.listManagedTags.mockRejectedValueOnce(new mocks.TagManagementApiError('unavailable', 503, 'TAG_MANAGEMENT_UNAVAILABLE'))
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('unavailable')
    expect(wrapper.text()).toContain('temporarily unavailable')
    expect(wrapper.find('[data-action="reload"]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
  })

  it('refreshes the authoritative list and discards Preview on preview TAG_NOT_FOUND', async () => {
    mocks.previewTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('missing', 404, 'TAG_NOT_FOUND'))
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockResolvedValueOnce([TAGS[1]!])
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(mocks.listManagedTags).toHaveBeenCalledTimes(2)
    expect(mocks.previewTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect((wrapper.get('#tag-management-destination').element as HTMLInputElement).value).toBe('Backend')
    expect(selectedTagSelectValue(wrapper, 'tag-management-source')).toBe('')
    expect(wrapper.text()).toContain('source or destination tag no longer exists')
  })

  it('refreshes the authoritative list on Apply TAG_NOT_FOUND without re-Applying', async () => {
    mocks.applyTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('missing', 404, 'TAG_NOT_FOUND'))
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockResolvedValueOnce([TAGS[1]!])
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(mocks.listManagedTags).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect((wrapper.get('#tag-management-destination').element as HTMLInputElement).value).toBe('Backend')
    expect(selectedTagSelectValue(wrapper, 'tag-management-source')).toBe('')
    expect(wrapper.text()).toContain('source or destination tag no longer exists')
  })

  it('clears a deleted Merge destination after Apply TAG_NOT_FOUND and requires a new Preview', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeMergePreview())
    mocks.applyTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('missing', 404, 'TAG_NOT_FOUND'))
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockResolvedValueOnce([TAGS[0]!])
    const wrapper = mountTracked({ selectedTag: 'Java' })
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.find('.tag-management-preview').exists()).toBe(true)

    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(mocks.listManagedTags).toHaveBeenCalledTimes(2)
    expect(mocks.previewTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(selectedTagSelectValue(wrapper, 'tag-management-source')).toBe('7')
    expect(selectedTagSelectValue(wrapper, 'tag-management-destination')).toBe('')
    expect(tagSelectOptionValues(wrapper, 'tag-management-destination')).toEqual([''])
    expect(wrapper.text()).toContain('source or destination tag no longer exists')

    await wrapper.get('form').trigger('submit')
    await settle()
    expect(mocks.previewTagOperation).toHaveBeenCalledTimes(1)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
  })

  it('health-blocks management on TAG_IDENTITY_CONFLICT', async () => {
    mocks.previewTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('identity conflict', 409, 'TAG_IDENTITY_CONFLICT'))
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('unavailable')
    expect(wrapper.text()).toContain('Tag identity health failed')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
  })

  it('offers Merge and binds an existing destination by stable ID', async () => {
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')

    expect(tagSelectOptionValues(wrapper, 'tag-management-destination')).toEqual(['', '20'])
    expect(wrapper.find('[data-operation="remove"]').exists()).toBe(true)

    await wrapper.get('#tag-management-destination-search').setValue('python')
    expect(tagSelectOptionValues(wrapper, 'tag-management-destination')).toEqual(['', '20'])
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    expect(selectedTagSelectValue(wrapper, 'tag-management-destination')).toBe('20')
    expect(wrapper.find('[data-selected-destination]').text()).toContain('Python')

    await wrapper.get('#tag-management-destination-search').setValue('java')
    expect(selectedTagSelectValue(wrapper, 'tag-management-destination')).toBe('20')
    expect(wrapper.find('[data-selected-destination]').text()).toContain('Python')
    expect(tagSelectOptionValues(wrapper, 'tag-management-destination')).toEqual(['', '20'])
  })

  it('requires a current Merge Preview and renders overlap, survivor, and deletion evidence', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeMergePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeMergeResult())
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockResolvedValueOnce([TAGS[1]!])
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12 })
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)

    await wrapper.get('form').trigger('submit')
    await settle()
    expect(mocks.previewTagOperation).toHaveBeenCalledWith(mergeOperation)
    expect(wrapper.findAll('.tag-management-summary dd')[0]?.text()).toBe('Merge')
    expect(wrapper.text()).toContain('Duplicate associations collapsed')
    expect(wrapper.text()).toContain('Source-only documents receive the destination tag')
    expect(wrapper.text()).toContain('The destination tag will survive')
    expect(wrapper.text()).toContain('will be deleted')
    expect(wrapper.text()).toContain('1')
    expect(wrapper.get('.tag-management-preview .primary').text()).toContain('Apply Merge')

    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledWith(mergeOperation, 'a'.repeat(64))
    expect(wrapper.get('.tag-management-state-success').attributes('data-selected-tag')).toBe('Python')
    expect(wrapper.text()).toContain('Surviving destination tag: Python')
  })

  it('shows Remove without destination controls and previews the exact destructive impact', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')

    expect(wrapper.find('#tag-management-destination').exists()).toBe(false)
    expect(wrapper.find('#tag-management-destination-search').exists()).toBe(false)
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(mocks.previewTagOperation).toHaveBeenCalledWith(removeOperation)
    expect(wrapper.findAll('.tag-management-summary dd')[0]?.text()).toBe('Remove')
    expect(wrapper.findAll('.tag-management-summary dd')[1]?.text()).toBe('#Java')
    expect(wrapper.text()).toContain('The tag will be removed from all affected documents')
    expect(wrapper.text()).toContain('The documents themselves will not be deleted')
    expect(wrapper.text()).toContain('Markdown/frontmatter files')
    expect(wrapper.text()).toContain('global tag record will be deleted')
    expect(wrapper.text()).toContain('Affected document sample')
    expect(wrapper.text()).toContain('Associations removed')
    expect(wrapper.text()).toContain('Tags deleted')
    expect(wrapper.get('[data-action="remove-apply"]').text()).toBe('Remove #Java')

    const confirmation = pendingRemovalConfirmation()
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(mocks.confirmCancellable).toHaveBeenCalledWith(
      'Remove tag #Java?',
      expect.stringContaining('Documents and Markdown files remain'),
      expect.objectContaining({
        cancelLabel: 'Cancel',
        confirmLabel: 'Remove #Java',
        destructive: true,
      }),
    )
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()

    confirmation.resolve(false)
    await settle()
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('preview-ready')
    expect(wrapper.get('.tag-management-live').text()).toContain('Removal cancelled')
  })

  it('requires confirmation before one Remove Apply and reports the removed source', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeRemoveResult())
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockResolvedValueOnce([TAGS[1]!])
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12 })
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()

    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(mocks.applyTagOperation).toHaveBeenCalledWith(removeOperation, 'a'.repeat(64))
    expect(wrapper.get('.tag-management-state-success').attributes('data-selected-tag')).toBeUndefined()
    expect(wrapper.text()).toContain('#Java was removed')
    expect(wrapper.text()).not.toContain('Final display name')
  })

  it('allows an orphan Remove with zero affected documents', async () => {
    const orphan = { id: 30, normalizedName: 'orphan', displayName: 'Orphan', documentCount: 0 }
    mocks.listManagedTags.mockReset().mockResolvedValueOnce([...TAGS, orphan]).mockResolvedValueOnce([TAGS[1]!])
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview({
      sourceTag: { id: 30, normalizedName: 'orphan', displayName: 'Orphan' },
      operation: { kind: 'remove', sourceTagId: 30 },
      affectedCount: 0,
      associationRemoves: 0,
      sample: [],
    }))
    mocks.applyTagOperation.mockResolvedValueOnce(makeRemoveResult({
      operation: { kind: 'remove', sourceTagId: 30 },
      sourceTagId: 30,
      affectedCount: 0,
      associationRemoves: 0,
      versionUpdateCount: 0,
    }))
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '30')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).toContain('not currently assigned to any documents')
    expect(wrapper.text()).toContain('delete only the global tag record')
    expect(wrapper.text()).toContain('Affected documents')
    expect(wrapper.findAll('.tag-management-summary dd')[2]?.text()).toBe('0')
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('#Orphan was removed')
  })

  it('invalidates a pending destructive confirmation when the source changes', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    const confirmation = pendingRemovalConfirmation()
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '')
    await settle()
    expect(confirmation.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
  })

  it('handles Remove stale Apply without retrying automatically', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('stale', 409, 'PREVIEW_STALE'))
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(wrapper.get('.tag-management-live').text()).toContain('Tags changed after this Preview')
  })

  it('refreshes a missing Remove source after Apply TAG_NOT_FOUND without re-Applying', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('missing', 404, 'TAG_NOT_FOUND'))
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockResolvedValueOnce([TAGS[1]!])
    const wrapper = mountTracked({ selectedTag: 'Java' })
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(mocks.listManagedTags).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(selectedTagSelectValue(wrapper, 'tag-management-source')).toBe('')
    expect(wrapper.text()).toContain('source or destination tag no longer exists')
  })

  it('keeps committed Remove sync-pending and retries synchronization only', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeRemoveResult())
    let syncAttempts = 0
    const syncAfterCommit = vi.fn(async () => {
      syncAttempts += 1
      if (syncAttempts === 1) throw new Error('sync unavailable')
      return { managedTags: [TAGS[1]!], selectedTag: null }
    })
    const wrapper = mountTracked({ syncAfterCommit })
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(syncAfterCommit).toHaveBeenCalledTimes(2)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('success')
  })

  it('preserves a newer user selection when Remove synchronization resolves', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeRemoveResult())
    let resolveSync: ((value: { managedTags: ManagedTag[]; selectedTag: string | null }) => void) | undefined
    const syncAfterCommit = vi.fn(() => new Promise<{ managedTags: ManagedTag[]; selectedTag: string | null }>((resolve) => {
      resolveSync = resolve
    }))
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12, syncAfterCommit })
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('syncing')
    await wrapper.setProps({ selectedTag: 'Python', selectionEpoch: 13 })
    resolveSync?.({ managedTags: [TAGS[1]!], selectedTag: 'Python' })
    await settle()
    expect(syncAfterCommit).toHaveBeenCalledWith(
      makeRemoveResult(),
      expect.objectContaining({ selectedTag: 'Java', selectedTagId: 7, selectionEpoch: 12 }),
    )
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.tag-management-state-success').attributes('data-selected-tag')).toBe('Python')
  })

  it('preserves committed state and delegates protocol-mismatch recovery to VaultView', async () => {
    const reviewedPreview = makeMergePreview()
    const changedResult = makeMergeResult({
      destinationTag: { id: 20, normalizedName: 'python', displayName: 'Changed' },
      survivorTag: { id: 20, normalizedName: 'python', displayName: 'Changed' },
      destinationDisplayName: 'Changed',
      survivorDisplayName: 'Changed',
    })
    mocks.previewTagOperation.mockResolvedValueOnce(reviewedPreview)
    mocks.applyTagOperation.mockResolvedValueOnce(changedResult)
    mocks.assertApplyResultMatchesReviewedPreview.mockImplementationOnce((result: TagOperationApplyResult, preview: TagOperationPreview) => {
      expect(result).toBe(changedResult)
      expect(preview).toBe(reviewedPreview)
      throw new mocks.TagManagementApiError('invalid response', 200, 'CLIENT_PROTOCOL_ERROR')
    })
    const syncAfterCommit = vi.fn(async () => ({ managedTags: TAGS, selectedTag: 'Python' }))
    const recoverCommittedOperation = vi.fn(async () => ({ managedTags: [TAGS[1]!], selectedTag: 'Python' }))
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12, syncAfterCommit, recoverCommittedOperation })
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()

    expect(mocks.assertApplyResultMatchesReviewedPreview).toHaveBeenCalledTimes(1)
    expect(syncAfterCommit).not.toHaveBeenCalled()
    expect(recoverCommittedOperation).not.toHaveBeenCalled()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-diagnostic-code')).toBe('CLIENT_PROTOCOL_ERROR')
    expect(wrapper.find('.tag-management-state-success').exists()).toBe(false)
    expect(wrapper.text()).toContain('was committed')
    expect(wrapper.text()).toContain('did not match the reviewed Preview')
    expect(wrapper.text()).not.toContain('The tag operation failed')
    expect(wrapper.text()).not.toContain('Preview again before retrying')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(wrapper.get('.tag-management-state-error .primary').text()).toBe('Retry synchronization')

    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(recoverCommittedOperation).toHaveBeenCalledTimes(1)
    expect(recoverCommittedOperation).toHaveBeenCalledWith(
      mergeOperation,
      expect.objectContaining({ selectedTag: 'Java', selectedTagId: 7, selectionEpoch: 12 }),
    )
    expect(syncAfterCommit).not.toHaveBeenCalled()
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(wrapper.text()).toContain('Do not apply the operation again')
  })

  it('recovers a committed Remove from the trusted submitted operation', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeRemoveResult())
    mocks.assertApplyResultMatchesReviewedPreview.mockImplementationOnce(() => {
      throw new mocks.TagManagementApiError('invalid response', 200, 'CLIENT_PROTOCOL_ERROR')
    })
    const syncAfterCommit = vi.fn(async () => ({ managedTags: TAGS, selectedTag: 'Java' }))
    const recoverCommittedOperation = vi.fn(async (submittedOperation: TagOperationRequest, snapshot: TagSelectionSnapshot) => {
      expect(submittedOperation).toEqual(removeOperation)
      expect(snapshot).toMatchObject({ selectedTag: 'Java', selectedTagId: 7, selectionEpoch: 12 })
      return { managedTags: [TAGS[1]!], selectedTag: null }
    })
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12, syncAfterCommit, recoverCommittedOperation })
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveRemovalConfirmation(true)
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()

    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(syncAfterCommit).not.toHaveBeenCalled()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(recoverCommittedOperation).toHaveBeenCalledTimes(1)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('editing')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
  })

  it('keeps committed protocol mismatch recovery pending and retries the VaultView seam without re-applying', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeMergePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeMergeResult())
    mocks.assertApplyResultMatchesReviewedPreview.mockImplementationOnce(() => {
      throw new mocks.TagManagementApiError('invalid response', 200, 'CLIENT_PROTOCOL_ERROR')
    })
    const recoverCommittedOperation = vi.fn(async () => {
      throw new Error('VaultView refresh unavailable')
    })
    const wrapper = mountTracked({ recoverCommittedOperation })
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()

    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)

    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(recoverCommittedOperation).toHaveBeenCalledTimes(1)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    expect(wrapper.get('.tag-management-state-error .primary').text()).toBe('Retry synchronization')

    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(recoverCommittedOperation).toHaveBeenCalledTimes(2)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
  })

  it('clears a destination when the source changes to that stable ID and invalidates Preview', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeMergePreview())
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.find('.tag-management-preview').exists()).toBe(true)

    await setTagSelect(wrapper, 'tag-management-source', '20')
    await settle()
    expect(selectedTagSelectValue(wrapper, 'tag-management-destination')).toBe('')
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
  })

  it('invalidates a Merge Preview when switching back to Rename', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeMergePreview())
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.find('.tag-management-preview').exists()).toBe(true)

    await wrapper.get('[data-operation="rename"]').trigger('click')
    await settle()
    expect(wrapper.find('.tag-management-preview').exists()).toBe(false)
    expect(wrapper.find('#tag-management-destination-search').exists()).toBe(false)
    expect(wrapper.find('#tag-management-destination').element.tagName).toBe('INPUT')
  })

  it('does not route an impossible Merge DESTINATION_EXISTS error into Rename guidance', async () => {
    mocks.previewTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('collision', 409, 'DESTINATION_EXISTS'))
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).not.toContain('Use Merge instead')
    expect(wrapper.text()).toContain('This Preview cannot be applied')
  })

  it('keeps a committed Merge in sync-pending and retries sync without applying again', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeMergePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeMergeResult())
    let syncAttempts = 0
    const syncAfterCommit = vi.fn(async () => {
      syncAttempts += 1
      if (syncAttempts === 1) throw new Error('sync unavailable')
      return { managedTags: [TAGS[1]!], selectedTag: 'Python' }
    })
    const wrapper = mountTracked({ syncAfterCommit })
    await settle()
    await wrapper.get('[data-operation="merge"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await setTagSelect(wrapper, 'tag-management-destination', '20')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('sync-pending')
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(syncAfterCommit).toHaveBeenCalledTimes(2)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('success')
  })

  it('previews and applies a normal Rename with exact server counts and one sync cycle', async () => {
    const events: string[] = []
    const refreshPosts = vi.fn(async () => { events.push('posts-refresh') })
    mocks.listManagedTags
      .mockReset()
      .mockResolvedValueOnce(TAGS)
      .mockImplementationOnce(async () => { events.push('tag-list-refresh'); return RENAMED_TAGS })
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12, refreshPosts })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).toContain('Affected documents')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('Associations added')
    expect(wrapper.text()).toContain('Affected document sample')
    expect(wrapper.findAll('[data-state="preview-ready"]').length).toBe(1)
    expect(wrapper.get('.tag-management-live').text()).toContain('Preview ready')

    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(mocks.applyTagOperation).toHaveBeenCalledWith(operation, 'a'.repeat(64))
    expect(refreshPosts).toHaveBeenCalledTimes(1)
    expect(mocks.listManagedTags).toHaveBeenCalledTimes(2)
    expect(events).toEqual(['posts-refresh', 'tag-list-refresh'])
    expect(wrapper.text()).toContain('The tag operation was committed')
    expect(wrapper.text()).toContain('Final display name: Backend')
    expect(wrapper.get('.tag-management-live').text()).toContain('Tags are synchronized')
    expect(wrapper.get('.tag-management-state-success').attributes('data-selected-tag')).toBe('Backend')
  })

  it('labels server-authoritative Display Rename and explains identity preservation', async () => {
    const displayOperation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'JAVA' }
    mocks.previewTagOperation.mockResolvedValueOnce(makePreview({
      operation: displayOperation,
      requestedDestination: { displayName: 'JAVA', normalizedName: 'java' },
      displayOnly: true,
      associationAdds: 0,
      associationRemoves: 0,
    }))
    mocks.applyTagOperation.mockResolvedValueOnce(makeResult({
      operation: displayOperation,
      displayOnly: true,
    }))
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 1 })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('JAVA')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).toContain('Display Rename')
    expect(wrapper.text()).toContain('preserves the stable tag identity')
    const summaryValues = wrapper.findAll('.tag-management-summary dd').map((entry) => entry.text())
    expect(summaryValues[4]).toBe('0')
    expect(summaryValues[5]).toBe('0')
    expect(summaryValues[7]).toBe('0')
    expect(mocks.applyTagOperation).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'merge' }), expect.anything())
  })

  it('shows destination conflicts as a blocked Rename without exposing another operation', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makePreview({
      allowedToApply: false,
      conflictCode: 'DESTINATION_EXISTS',
      destinationTag: { id: 20, normalizedName: 'backend', displayName: 'Backend' },
    }))
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).toContain('already belongs to another tag')
    expect(wrapper.text()).toContain('Use Merge instead')
    expect(wrapper.find('[data-operation="merge"]').exists()).toBe(true)
    expect(wrapper.findAll('button').some((button) => /merge/i.test(button.text()))).toBe(true)
    expect(wrapper.find('.tag-management-preview .primary').attributes('disabled')).toBeDefined()
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
  })

  it('does not let a late Preview response overwrite a newer operation', async () => {
    let resolveFirst: ((value: TagOperationPreview) => void) | undefined
    let resolveSecond: ((value: TagOperationPreview) => void) | undefined
    mocks.previewTagOperation
      .mockReset()
      .mockReturnValueOnce(new Promise<TagOperationPreview>((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise<TagOperationPreview>((resolve) => { resolveSecond = resolve }))
    const secondOperation = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Later' }
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('First')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('#tag-management-destination').setValue('Later')
    await wrapper.get('form').trigger('submit')
    await settle()
    resolveSecond?.(makePreview({
      operation: secondOperation,
      requestedDestination: { displayName: 'Later', normalizedName: 'later' },
    }))
    await settle()
    resolveFirst?.(makePreview({
      requestedDestination: { displayName: 'First', normalizedName: 'first' },
    }))
    await settle()
    expect(wrapper.text()).toContain('#Later')
    expect(wrapper.text()).not.toContain('#First')
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
  })

  it('ignores a late Preview page from an obsolete generation and preserves newer loading state', async () => {
    let resolvePageA: ((value: TagOperationPreview) => void) | undefined
    let resolvePageB: ((value: TagOperationPreview) => void) | undefined
    const operationB = { kind: 'rename' as const, sourceTagId: 7, destinationName: 'Later' }
    const fingerprintA = 'a'.repeat(64)
    const fingerprintB = 'b'.repeat(64)
    mocks.previewTagOperation
      .mockReset()
      .mockResolvedValueOnce(makePreview({
        planFingerprint: fingerprintA,
        nextAfterDocumentId: 'a-cursor',
      }))
      .mockResolvedValueOnce(makePreview({
        operation: operationB,
        requestedDestination: { displayName: 'Later', normalizedName: 'later' },
        planFingerprint: fingerprintB,
        sample: [{ id: 'doc-b', path: 'inbox/b', title: 'Preview B' }],
        nextAfterDocumentId: 'b-cursor',
      }))
    mocks.getTagOperationPreviewPage
      .mockReset()
      .mockReturnValueOnce(new Promise<TagOperationPreview>((resolve) => { resolvePageA = resolve }))
      .mockReturnValueOnce(new Promise<TagOperationPreview>((resolve) => { resolvePageB = resolve }))

    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('First')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-sample .secondary').trigger('click')
    await settle()

    await wrapper.get('#tag-management-destination').setValue('Later')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.text()).toContain('Preview B')
    await wrapper.get('.tag-management-sample .secondary').trigger('click')
    await settle()
    expect(wrapper.get('.tag-management-sample .secondary').attributes('disabled')).toBeDefined()

    resolvePageA?.(makePreview({
      planFingerprint: fingerprintA,
      sample: [{ id: 'doc-a-old', path: 'inbox/a-old', title: 'Old A page' }],
      nextAfterDocumentId: 'a-next',
    }))
    await settle()
    expect(wrapper.text()).toContain('Preview B')
    expect(wrapper.text()).not.toContain('Old A page')
    expect(wrapper.get('.tag-management-sample .secondary').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).not.toContain('Tags changed after this Preview')

    resolvePageB?.(makePreview({
      operation: operationB,
      requestedDestination: { displayName: 'Later', normalizedName: 'later' },
      planFingerprint: fingerprintB,
      sample: [{ id: 'doc-b-page', path: 'inbox/b-page', title: 'New B page' }],
      nextAfterDocumentId: null,
    }))
    await settle()
    expect(wrapper.text()).toContain('New B page')
    expect(wrapper.find('.tag-management-sample .secondary').exists()).toBe(false)
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-state')).toBe('preview-ready')
  })

  it('invalidates the reviewed Preview as soon as an operation field changes', async () => {
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.findAll('[data-state="preview-ready"]').length).toBe(1)
    await wrapper.get('#tag-management-destination').setValue('New name')
    await settle()
    expect(wrapper.findAll('.tag-management-preview').length).toBe(0)
    expect(wrapper.findAll('[data-state="editing"]').length).toBe(1)
    expect(mocks.applyTagOperation).not.toHaveBeenCalled()
  })

  it('requires an explicit fresh Preview after a stale Apply and never retries automatically', async () => {
    mocks.applyTagOperation.mockRejectedValueOnce(new mocks.TagManagementApiError('stale', 409, 'PREVIEW_STALE'))
    const refreshPosts = vi.fn()
    const wrapper = mountTracked({ refreshPosts })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('Tags changed after this Preview')
    expect(wrapper.get('.tag-management-live').text()).toContain('Tags changed after this Preview')
    expect(wrapper.findAll('.tag-management-preview').length).toBe(0)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(refreshPosts).not.toHaveBeenCalled()
  })

  it('uses the originating fingerprint for pagination and invalidates pages on stale continuation', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makePreview({
      nextAfterDocumentId: 'doc-1',
    }))
    const wrapper = mountTracked()
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-sample .secondary').trigger('click')
    await settle()
    expect(mocks.getTagOperationPreviewPage).toHaveBeenCalledWith(operation, 'a'.repeat(64), 'doc-1', 100)
    expect(wrapper.text()).toContain('Two')

    mocks.getTagOperationPreviewPage.mockRejectedValueOnce(new mocks.TagManagementApiError('stale', 409, 'PREVIEW_STALE'))
    mocks.previewTagOperation.mockResolvedValueOnce(makePreview({ nextAfterDocumentId: 'doc-1' }))
    await wrapper.get('.tag-management-sample .secondary').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('Tags changed after this Preview')
    expect(wrapper.findAll('.tag-management-preview').length).toBe(0)
  })

  it('enters sync-pending after commit when refresh fails and retries sync without Apply', async () => {
    const refreshPosts = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(undefined)
    const wrapper = mountTracked({ refreshPosts })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(wrapper.findAll('[data-state="sync-pending"]').length).toBe(1)
    expect(wrapper.text()).toContain('operation succeeded')
    expect(wrapper.get('.tag-management-live').text()).toContain('operation succeeded')
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-can-leave')).toBe('false')
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    await wrapper.get('.tag-management-state-error .primary').trigger('click')
    await settle()
    expect(refreshPosts).toHaveBeenCalledTimes(2)
    expect(mocks.applyTagOperation).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-state="success"]').length).toBe(1)
  })

  it('preserves a newer user selection when Apply resolves', async () => {
    let resolveApply: ((value: TagOperationApplyResult) => void) | undefined
    let reconciledSelection = 'Java'
    mocks.applyTagOperation.mockReturnValueOnce(new Promise<TagOperationApplyResult>((resolve) => { resolveApply = resolve }))
    const refreshPosts = vi.fn().mockResolvedValue(undefined)
    const syncAfterCommit = vi.fn(async (_result: TagOperationApplyResult, _snapshot: TagSelectionSnapshot) => ({
      managedTags: RENAMED_TAGS,
      selectedTag: reconciledSelection,
    }))
    const wrapper = mountTracked({ selectedTag: 'Java', selectionEpoch: 12, refreshPosts, syncAfterCommit })
    await settle()
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    await wrapper.setProps({ selectedTag: 'Python', selectionEpoch: 13 })
    reconciledSelection = 'Python'
    resolveApply?.(makeResult())
    await settle()
    expect(syncAfterCommit).toHaveBeenCalledTimes(1)
    expect(syncAfterCommit.mock.calls[0]?.[1]).toMatchObject({ selectedTag: 'Java', selectionEpoch: 12 })
    expect(wrapper.get('.tag-management-state-success').attributes('data-selected-tag')).toBe('Python')
  })

  it('focuses invalid controls and blocks Escape while Apply is pending', async () => {
    const wrapper = mountTracked()
    await settle()
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(wrapper.get('#tag-management-source').element.contains(document.activeElement)).toBe(true)
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()
    expect(document.activeElement).toBe(wrapper.get('#tag-management-destination').element)

    let resolveApply: ((value: TagOperationApplyResult) => void) | undefined
    mocks.applyTagOperation.mockReturnValueOnce(new Promise<TagOperationApplyResult>((resolve) => { resolveApply = resolve }))
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('#tag-management-destination').setValue('Backend')
    await wrapper.get('form').trigger('submit')
    await settle()
    await wrapper.get('.tag-management-preview .primary').trigger('click')
    await settle()
    expect(wrapper.get('[data-tag-management-panel]').attributes('data-can-leave')).toBe('false')
    resolveApply?.(makeResult())
  })

  it('focuses the source on mount and exposes the Settings leave guard', async () => {
    const offsetParent = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)
    try {
      const wrapper = mountTracked()
      await settle()
      expect(wrapper.get('#tag-management-source').element.contains(document.activeElement)).toBe(true)
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
      expect(wrapper.find('[data-action="close"]').exists()).toBe(false)
      expect(wrapper.get('[data-tag-management-panel]').attributes('data-can-leave')).toBe('true')

      let resolveApply: ((value: TagOperationApplyResult) => void) | undefined
      mocks.applyTagOperation.mockReturnValueOnce(new Promise<TagOperationApplyResult>((resolve) => { resolveApply = resolve }))
      await setTagSelect(wrapper, 'tag-management-source', '7')
      await wrapper.get('#tag-management-destination').setValue('Backend')
      await wrapper.get('form').trigger('submit')
      await settle()
      await wrapper.get('.tag-management-preview .primary').trigger('click')
      await settle()
      expect(wrapper.get('[data-tag-management-panel]').attributes('data-can-leave')).toBe('false')
      resolveApply?.(makeResult())
      await settle()
      expect(wrapper.get('[data-tag-management-panel]').attributes('data-can-leave')).toBe('true')
    } finally {
      offsetParent.mockRestore()
    }
  })

  it('keeps critical management copy available in both supported locales', async () => {
    useI18n().setLocale('zh')
    const wrapper = mountTracked()
    await settle()
    expect(wrapper.find('.tag-management-header').exists()).toBe(false)
    expect(wrapper.get('[data-tag-management-panel]').attributes('aria-label')).toBe('标签')
    expect(wrapper.text()).toContain('重命名')
    expect(useI18n().t('tags.manage.conflict_destination_exists')).toContain('合并标签')
    useI18n().setLocale('en')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.tag-management-header').exists()).toBe(false)
    expect(wrapper.get('[data-tag-management-panel]').attributes('aria-label')).toBe('Tags')
    expect(wrapper.text()).toContain('Rename')
    expect(useI18n().t('tags.manage.conflict_destination_exists')).toContain('Use Merge instead')
  })

  it('covers Remove-specific preview, warning, confirmation, and success copy in both locales', async () => {
    mocks.previewTagOperation.mockResolvedValueOnce(makeRemovePreview())
    mocks.applyTagOperation.mockResolvedValueOnce(makeRemoveResult())
    const wrapper = mountTracked()

    useI18n().setLocale('zh')
    await settle()
    await wrapper.get('[data-operation="remove"]').trigger('click')
    await setTagSelect(wrapper, 'tag-management-source', '7')
    await wrapper.get('form').trigger('submit')
    await settle()

    expect(wrapper.get('[data-operation="remove"]').text()).toContain('删除')
    expect(wrapper.findAll('.tag-management-summary dd')[1]?.text()).toBe('#Java')
    const chineseExplanation = wrapper.get('#tag-management-remove-explanation').text()
    expect(chineseExplanation).toContain('文档本身不会被删除')
    expect(chineseExplanation).toContain('Markdown/frontmatter')
    expect(chineseExplanation).toContain('不会被修改')
    expect(chineseExplanation).toContain('全局标签记录将被删除')
    expect(wrapper.get('.tag-management-warnings').text()).toContain('此操作具有破坏性')
    expect(wrapper.get('[data-action="remove-apply"]').text()).toBe('删除 #Java')

    const chineseConfirmation = pendingRemovalConfirmation()
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(mocks.confirmCancellable).toHaveBeenLastCalledWith(
      '确认删除标签 #Java？',
      expect.stringContaining('文档和 Markdown 文件会保留'),
      expect.objectContaining({
        cancelLabel: '取消',
        confirmLabel: '删除 #Java',
        destructive: true,
      }),
    )
    chineseConfirmation.resolve(false)
    await settle()

    useI18n().setLocale('en')
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-operation="remove"]').text()).toContain('Remove')
    expect(wrapper.findAll('.tag-management-summary dd')[1]?.text()).toBe('#Java')
    const englishExplanation = wrapper.get('#tag-management-remove-explanation').text()
    expect(englishExplanation).toContain('The documents themselves will not be deleted')
    expect(englishExplanation).toContain('Markdown/frontmatter files')
    expect(englishExplanation).toContain('global tag record will be deleted')
    expect(wrapper.get('.tag-management-warnings').text()).toContain('This operation is destructive')
    expect(wrapper.get('[data-action="remove-apply"]').text()).toBe('Remove #Java')

    const englishConfirmation = pendingRemovalConfirmation()
    await wrapper.get('[data-action="remove-apply"]').trigger('click')
    await settle()
    expect(mocks.confirmCancellable).toHaveBeenLastCalledWith(
      'Remove tag #Java?',
      expect.stringContaining('Documents and Markdown files remain'),
      expect.objectContaining({
        cancelLabel: 'Cancel',
        confirmLabel: 'Remove #Java',
        destructive: true,
      }),
    )
    englishConfirmation.resolve(true)
    await settle()
    expect(wrapper.text()).toContain('#Java was removed')
  })
})
