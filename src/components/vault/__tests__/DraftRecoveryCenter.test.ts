// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import DraftRecoveryCenter from '../DraftRecoveryCenter.vue'
import { capacitySnapshot, primaryRecoveryRecord } from '../../../composables/vault/draft-recovery/draftCleanup'
import type { UnsavedDraft } from '../../../composables/vault/draft-recovery/draftTypes'
import type { DraftRecoveryItem } from '../../../composables/vault/draft-recovery/useUnsavedDraftRecovery'

function draft(): UnsavedDraft {
  return {
    version: 1,
    vaultId: 'vault',
    documentId: 'doc',
    documentPath: 'notes/private.md',
    content: 'local bytes',
    baseContentHash: null,
    baseModifiedAt: null,
    createdAt: 1,
    updatedAt: 2,
  }
}

const wrappers: Array<{ unmount(): void }> = []
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

function setup(protectedRecord = false) {
  const record = primaryRecoveryRecord(draft())
  const id = JSON.stringify(['vault', 'doc'])
  const wrapper = mount(DraftRecoveryCenter, {
    props: {
      records: [record],
      items: [{
        recoveryId: id,
        draft: draft(),
        source: 'primary',
        conflict: null,
        decision: { kind: 'missing-source', draft: draft(), disk: { status: 'missing', documentPath: 'notes/private.md' } },
        status: 'ready',
        error: null,
      }],
      capacity: capacitySnapshot([record]),
      unsupportedCount: 2,
      selectedIds: new Set<string>(),
      protectedIds: protectedRecord ? new Set([id]) : new Set<string>(),
      loading: false,
      error: null,
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

function mountCenter(error: string) {
  const item: DraftRecoveryItem = {
    recoveryId: JSON.stringify(['vault', 'doc']),
    draft: draft(),
    source: 'primary',
    conflict: null,
    decision: { kind: 'missing-source', draft: draft(), disk: { status: 'missing', documentPath: 'notes/private.md' } },
    status: 'ready',
    error: null,
  }
  const wrapper = mount(DraftRecoveryCenter, {
    props: {
      records: [],
      items: [item],
      capacity: capacitySnapshot([]),
      unsupportedCount: 0,
      selectedIds: new Set<string>(),
      protectedIds: new Set<string>(),
      loading: false,
      error,
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('DraftRecoveryCenter', () => {
  it('shows device-local capacity metadata without exposing content', () => {
    const wrapper = setup()
    expect(wrapper.text()).toContain('notes/private.md')
    expect(wrapper.text()).toContain('1 unsaved item')
    expect(wrapper.text()).toContain('newer Nuvyn version')
    expect(wrapper.text()).not.toContain('local bytes')
  })

  it('disables selection and deletion for protected records', () => {
    const wrapper = setup(true)
    expect(wrapper.get('[role="checkbox"]').attributes('aria-disabled')).toBe('true')
    const buttons = wrapper.findAll('button')
    const deleteButton = buttons.at(-1)!
    expect(deleteButton.attributes('disabled')).toBeDefined()
  })

  it('shows only the error state with a retry action when the storage read failed', async () => {
    const wrapper = mountCenter('transaction-failed')
    // The error state is mutually exclusive with the inventory states: a
    // failed read is NOT a certified "no unsaved content" result, so the
    // summary/empty text must not render underneath the error.
    expect(wrapper.text()).toContain('Could not inspect local recovery records')
    expect(wrapper.text()).not.toContain('unsaved item')
    expect(wrapper.text()).not.toContain('no local recovery records')
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('explains a recovery store blocked by another Nuvyn page', () => {
    const wrapper = mountCenter('upgrade-blocked')
    expect(wrapper.text()).toContain('another Nuvyn page')
    expect(wrapper.text()).not.toContain('Could not inspect local recovery records')
  })
})
