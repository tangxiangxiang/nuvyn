// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import EditorTabs from '../EditorTabs.vue'
import type { WorkspaceTab } from '../tabs'

enableAutoUnmount(afterEach)

const detachedFixtures = new Set<HTMLElement>()

afterEach(() => {
  for (const fixture of detachedFixtures) fixture.remove()
  detachedFixtures.clear()
})

function appendFixture(element: HTMLElement): HTMLElement {
  document.body.appendChild(element)
  detachedFixtures.add(element)
  return element
}

function makeTab(id: string): WorkspaceTab {
  return {
    id,
    label: id,
    title: id,
    kind: 'document',
    documentPath: id,
    save: {
      status: 'idle',
      dirty: false,
      inFlight: false,
      retryable: false,
      attention: false,
      hasNewerChanges: false,
    },
  }
}

describe('EditorTabs focus behavior characterization', () => {
  it('focuses active and non-active workspace tabs without selecting them', () => {
    const wrapper = mount(EditorTabs, {
      props: {
        tabs: [makeTab('a'), makeTab('b')],
        activePath: 'a',
      },
      attachTo: document.body,
    })

    wrapper.vm.focusTab('b')
    expect(document.activeElement).toBe(wrapper.get('[data-tab-id="b"]').element)
    expect(wrapper.get('[data-tab-id="a"]').attributes('aria-selected')).toBe('true')

    wrapper.vm.focusTab('a')
    expect(document.activeElement).toBe(wrapper.get('[data-tab-id="a"]').element)
  })

  it('leaves the current focus unchanged when the workspace ID is unknown', () => {
    const outside = appendFixture(document.createElement('button'))
    outside.focus()

    const wrapper = mount(EditorTabs, {
      props: {
        tabs: [makeTab('a'), makeTab('b')],
        activePath: 'a',
      },
      attachTo: document.body,
    })

    wrapper.vm.focusTab('missing')
    expect(document.activeElement).toBe(outside)
  })

  it('scopes workspace tab lookup to its own tab strip', () => {
    const foreignTab = appendFixture(document.createElement('button'))
    foreignTab.dataset.tabId = 'foreign'
    foreignTab.setAttribute('role', 'tab')
    foreignTab.focus()

    const wrapper = mount(EditorTabs, {
      props: {
        tabs: [makeTab('a')],
        activePath: 'a',
      },
      attachTo: document.body,
    })

    wrapper.vm.focusTab('foreign')
    expect(document.activeElement).toBe(foreignTab)
  })
})
