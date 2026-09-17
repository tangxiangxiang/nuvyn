// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { DraftRecoveryDecisionKind } from '../../../composables/vault/draft-recovery/draftRecoveryDecision'
import {
  UNSAVED_DRAFT_VERSION,
  type UnsavedDraft,
} from '../../../composables/vault/draft-recovery/draftTypes'
import type { DraftRecoveryItem } from '../../../composables/vault/draft-recovery/useUnsavedDraftRecovery'
import DraftRecoveryPrompt from '../DraftRecoveryPrompt.vue'

enableAutoUnmount(afterEach)

function item(kind: DraftRecoveryDecisionKind): DraftRecoveryItem {
  const draft: UnsavedDraft = {
    version: UNSAVED_DRAFT_VERSION,
    vaultId: 'vault',
    documentId: 'document-a',
    documentPath: 'notes/a',
    content: 'secret body',
    baseContentHash: null,
    baseModifiedAt: 1,
    createdAt: 1,
    updatedAt: 2,
  }
  return {
    recoveryId: 'recovery-a',
    draft,
    source: 'primary',
    conflict: null,
    status: 'ready',
    error: null,
    decision: {
      kind,
      draft,
      disk: kind === 'missing-source'
        ? { status: 'missing', documentPath: 'notes/a' }
        : {
            status: 'ready',
            documentPath: 'notes/a',
            documentId: kind === 'identity-mismatch' ? 'replacement' : 'document-a',
            raw: 'disk',
            mtime: 1,
          },
    },
  }
}

function labels(kind: DraftRecoveryDecisionKind): string[] {
  const wrapper = mount(DraftRecoveryPrompt, {
    props: { item: item(kind) },
    attachTo: document.body,
  })
  const values = [...document.querySelectorAll('.draft-recovery-dialog button')]
    .map((button) => button.textContent?.trim() ?? '')
  wrapper.unmount()
  return values
}

describe('DraftRecoveryPrompt', () => {
  it('offers a conflict candidate as read-only recovery content instead of restoring it over the document', () => {
    const conflict = item('baseline-match')
    conflict.source = 'conflict'
    conflict.conflict = {
      version: 1,
      conflictId: 'local-conflict',
      vaultId: 'vault',
      documentId: 'document-a',
      documentPath: 'notes/a',
      content: 'secret body',
      baseContentHash: null,
      baseModifiedAt: 1,
      createdAt: 1,
      updatedAt: 3,
      origin: 'delete-conflict',
      crossContextUpdatedAt: 2,
      recordedAt: 3,
    }
    const wrapper = mount(DraftRecoveryPrompt, {
      props: { item: conflict },
      attachTo: document.body,
    })

    const actions = [...document.querySelectorAll('.draft-recovery-dialog button')]
      .map((button) => button.textContent?.trim() ?? '')
    expect(actions).toContain('Open Recovered Content')
    expect(actions).toContain('Discard Draft')
    expect(actions).not.toContain('Restore Draft')
    expect(actions).not.toContain('Use Disk Version')
    wrapper.unmount()
  })

  it('offers direct restore only for a baseline match', () => {
    expect(labels('baseline-match')).toEqual(['Restore Draft', 'Use Disk Version', 'Later', 'View All Unsaved Content'])
  })

  it('offers safe read-only views for divergent and unknown drafts', () => {
    expect(labels('divergent')).toEqual([
      'View Diff',
      'Open Recovered Content',
      'Use Disk Version',
      'Later',
      'View All Unsaved Content',
    ])
    expect(labels('unknown')).toEqual([
      'View Diff',
      'Open Recovered Content',
      'Use Disk Version',
      'Later',
      'View All Unsaved Content',
    ])
  })

  it('offers retry instead of diff when an unknown disk snapshot is unreadable', () => {
    const unreadable = item('unknown')
    unreadable.decision!.disk = {
      status: 'unreadable',
      documentPath: 'notes/a',
      error: 'private',
    }
    mount(DraftRecoveryPrompt, {
      props: { item: unreadable },
      attachTo: document.body,
    })

    const values = [...document.querySelectorAll('.draft-recovery-dialog button')]
      .map((button) => button.textContent?.trim() ?? '')
    expect(values).toEqual([
      'Retry',
      'Open Recovered Content',
      'Use Disk Version',
      'Later',
      'View All Unsaved Content',
    ])
  })

  it('never offers restore-to-document for missing or mismatched identities', () => {
    expect(labels('missing-source')).toEqual(['Open Recovered Content', 'Discard Draft', 'Later', 'View All Unsaved Content'])
    expect(labels('identity-mismatch')).toEqual(['Open Recovered Content', 'Discard Draft', 'Later', 'View All Unsaved Content'])
  })

  it('treats Escape as Later without exposing draft content', async () => {
    const wrapper = mount(DraftRecoveryPrompt, {
      props: { item: item('baseline-match') },
      attachTo: document.body,
    })
    document.querySelector('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('later')).toEqual([['recovery-a']])
    expect(document.querySelector('[role="dialog"]')?.textContent)
      .not.toContain('secret body')
  })
})
