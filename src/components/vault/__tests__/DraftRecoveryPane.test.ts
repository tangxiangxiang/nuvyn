// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { DraftRecoveryTab } from '../../../composables/vault/draft-recovery/useDraftRecoveryTabs'
import DraftRecoveryPane from '../DraftRecoveryPane.vue'

enableAutoUnmount(afterEach)

function recovery(
  overrides: Partial<DraftRecoveryTab> = {},
): DraftRecoveryTab {
  return {
    tabId: 'recovery:vault:document-a',
    recoveryId: 'recovery-a',
    source: 'primary',
    documentId: 'document-a',
    documentPath: 'notes/a',
    documentTitle: 'A',
    decisionKind: 'unknown',
    diskStatus: 'ready',
    diskDocumentId: 'document-a',
    canViewCurrent: true,
    canViewDiff: true,
    view: 'content',
    draftRaw: 'private draft',
    diskRaw: 'disk',
    status: 'ready',
    error: null,
    ...overrides,
  }
}

function toolbarLabels(tab: DraftRecoveryTab): string[] {
  const wrapper = mount(DraftRecoveryPane, {
    props: { recovery: tab },
    global: {
      stubs: {
        ReadingPane: true,
        HistoryUnifiedDiff: true,
      },
    },
  })
  return wrapper.findAll('[role="toolbar"] button').map((button) => button.text())
}

describe('DraftRecoveryPane', () => {
  it('emits the recovery identity when viewing the current document', async () => {
    const wrapper = mount(DraftRecoveryPane, {
      props: { recovery: recovery() },
      global: { stubs: { ReadingPane: true, HistoryUnifiedDiff: true } },
    })

    await wrapper.findAll('[role="toolbar"] button')
      .find((button) => button.text() === 'View Current Document')!
      .trigger('click')

    expect(wrapper.emitted('view-current')).toEqual([['recovery-a']])
  })

  it('shows View Current only when stable disk identity matches', () => {
    expect(toolbarLabels(recovery())).toContain('View Current Document')
    expect(toolbarLabels(recovery({
      diskDocumentId: null,
      canViewCurrent: false,
    }))).not.toContain('View Current Document')
    expect(toolbarLabels(recovery({
      diskStatus: 'unreadable',
      diskDocumentId: null,
      canViewCurrent: false,
      canViewDiff: false,
      diskRaw: null,
    }))).not.toContain('View Current Document')
  })

  it('shows View Diff only when disk content is available', () => {
    expect(toolbarLabels(recovery())).toContain('View Diff')
    expect(toolbarLabels(recovery({
      diskStatus: 'unreadable',
      diskDocumentId: null,
      canViewCurrent: false,
      canViewDiff: false,
      diskRaw: null,
    }))).not.toContain('View Diff')
  })
})
