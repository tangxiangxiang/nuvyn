// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import EditorTabs from '../EditorTabs.vue'
import type { WorkspaceTab } from '../tabs'
import { deriveDocumentSavePresentation } from '../../../composables/vault/editor-tabs/savePresentation'
import {
  focusedWorkspaceTabId,
  restoreRenamedWorkspaceTabFocus,
} from '../workspaceTabFocus'

function tab(id: string): WorkspaceTab {
  return {
    id,
    label: id,
    title: id,
    kind: 'document',
    documentPath: id,
    save: deriveDocumentSavePresentation(null),
  }
}

describe('workspaceTabFocus', () => {
  it('moves focus from a renamed tab to its replacement at the same position', async () => {
    const wrapper = mount(EditorTabs, {
      props: { tabs: [tab('b'), tab('a'), tab('c')], activePath: 'a' },
      attachTo: document.body,
    })
    const oldTab = wrapper.find('[data-tab-id="a"]').element as HTMLElement
    oldTab.focus()
    const focused = focusedWorkspaceTabId()
    expect(focused).toBe('a')

    await wrapper.setProps({ tabs: [tab('b'), tab('x'), tab('c')], activePath: 'x' })
    await restoreRenamedWorkspaceTabFocus(
      focused,
      [{ from: 'a', to: 'x' }],
      (id) => (wrapper.vm as unknown as { focusTab: (tabId: string) => void }).focusTab(id),
    )

    expect(wrapper.find('[data-tab-id="a"]').exists()).toBe(false)
    expect(wrapper.findAll('.tab').map((row) => row.attributes('data-tab-id')))
      .toEqual(['b', 'x', 'c'])
    expect(document.activeElement).toBe(wrapper.find('[data-tab-id="x"]').element)
    wrapper.unmount()
  })

  it('does not move focus when another surface owned it before rename', async () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    let focusedId: string | null = null
    expect(await restoreRenamedWorkspaceTabFocus(
      focusedWorkspaceTabId(),
      [{ from: 'a', to: 'x' }],
      (id) => { focusedId = id },
    )).toBe(false)
    expect(focusedId).toBeNull()
    expect(document.activeElement).toBe(button)
    button.remove()
  })

  it('does not restore stale focus when the user moves elsewhere before the rename renders', async () => {
    const oldTab = document.createElement('button')
    const sidebar = document.createElement('button')
    oldTab.dataset.tabId = 'a'
    document.body.append(oldTab, sidebar)
    oldTab.focus()
    const focusTab = vi.fn()

    const restoring = restoreRenamedWorkspaceTabFocus(
      'a',
      [{ from: 'a', to: 'x' }],
      focusTab,
      oldTab,
    )
    sidebar.focus()
    await restoring

    expect(focusTab).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(sidebar)
    oldTab.remove()
    sidebar.remove()
  })
})
