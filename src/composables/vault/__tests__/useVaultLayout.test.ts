// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { __resetVaultLayoutState, useVaultLayout } from '../useVaultLayout'

const STORAGE_KEY = 'nuvyn.vault.layout'

function setup() {
  let layout!: ReturnType<typeof useVaultLayout>
  const wrapper = mount(defineComponent({
    setup() {
      layout = useVaultLayout()
      return () => h('div')
    },
  }))
  return { layout, wrapper }
}

describe('useVaultLayout', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetVaultLayoutState()
  })

  afterEach(() => localStorage.clear())

  it('starts with one visible 380px right rail on the TOC tab', () => {
    const { layout } = setup()
    expect(layout.rightRailTab.value).toBe('toc')
    expect(layout.rightRailWidth.value).toBe(380)
    expect(layout.rightRailCollapsed.value).toBe(false)
    expect(layout.vaultStyle.value.gridTemplateColumns).toBe('40px 260px 1px 1fr 1px minmax(280px, max(280px, min(380px, 560px, 38vw)))')
  })

  it('migrates legacy file tree and TOC width fields', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fileTreeOpen: false,
      fileTreeWidth: 312,
      tocPanelWidth: 404,
    }))
    const { layout } = setup()
    expect(layout.activePanel.value).toBeNull()
    expect(layout.sidePanelWidth.value).toBe(312)
    expect(layout.rightRailWidth.value).toBe(404)
    expect(layout.rightRailTab.value).toBe('toc')
  })

  it('migrates an open legacy AI panel to the AI tab', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activePanel: 'files',
      aiOpen: true,
      aiPanelWidth: 470,
      rightRailCollapsed: true,
    }))
    const { layout } = setup()
    expect(layout.rightRailTab.value).toBe('ai')
    expect(layout.rightRailWidth.value).toBe(470)
    expect(layout.rightRailCollapsed.value).toBe(false)
  })

  it('clamps migrated right rail width to the supported range', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rightRailWidth: 999 }))
    expect(setup().layout.rightRailWidth.value).toBe(560)
  })

  it('right-rail toggle only opens and collapses without changing the selected tab', () => {
    const { layout } = setup()
    layout.rightRailCollapsed.value = true
    layout.toggleRightRail()
    expect(layout.rightRailCollapsed.value).toBe(false)
    expect(layout.rightRailTab.value).toBe('toc')

    layout.rightRailTab.value = 'links'
    layout.toggleRightRail()
    expect(layout.rightRailTab.value).toBe('links')
    expect(layout.rightRailCollapsed.value).toBe(true)

    layout.toggleRightRail()
    expect(layout.rightRailCollapsed.value).toBe(false)
  })

  it('collapses and restores the last selected side panel', () => {
    const { layout } = setup()
    expect(layout.activePanel.value).toBe('files')
    expect(layout.leftSidebarVisible.value).toBe(true)

    layout.toggleSidePanel()
    expect(layout.activePanel.value).toBe('files')
    expect(layout.leftSidebarCollapsed.value).toBe(true)
    expect(layout.leftSidebarVisible.value).toBe(false)
    expect(layout.sidePanelOpen.value).toBe(false)
    expect(layout.vaultStyle.value.gridTemplateColumns).toBe('1fr 1px minmax(280px, max(280px, min(380px, 560px, 38vw)))')

    layout.toggleSidePanel()
    expect(layout.activePanel.value).toBe('files')
    expect(layout.leftSidebarCollapsed.value).toBe(false)
    expect(layout.leftSidebarVisible.value).toBe(true)

    layout.selectPanel('tags')
    layout.toggleSidePanel()
    expect(layout.activePanel.value).toBe('tags')
    layout.toggleSidePanel()
    expect(layout.activePanel.value).toBe('tags')
  })

  it('removes the right rail tracks when collapsed', () => {
    const { layout } = setup()
    layout.rightRailCollapsed.value = true
    expect(layout.vaultStyle.value.gridTemplateColumns).toBe('40px 260px 1px 1fr')
  })

  it('removes all workspace chrome tracks when the sidebar is hidden', () => {
    const sidebarVisible = ref(false)
    let layout!: ReturnType<typeof useVaultLayout>
    const wrapper = mount(defineComponent({
      setup() {
        layout = useVaultLayout({ sidebarVisible })
        return () => h('div')
      },
    }))

    expect(layout.vaultStyle.value.gridTemplateColumns).toBe('1fr')
    expect(layout.vaultStyle.value.gridTemplateRows).toBe('1fr')

    sidebarVisible.value = true
    expect(layout.vaultStyle.value.gridTemplateColumns).toContain('40px')
    wrapper.unmount()
  })

  it('removes the status-bar row when the workspace has no document', () => {
    const statusBarVisible = ref(false)
    let layout!: ReturnType<typeof useVaultLayout>
    const wrapper = mount(defineComponent({
      setup() {
        layout = useVaultLayout({ statusBarVisible })
        return () => h('div')
      },
    }))

    expect(layout.vaultStyle.value.gridTemplateRows).toBe('1fr')

    statusBarVisible.value = true
    expect(layout.vaultStyle.value.gridTemplateRows).toBe('1fr 24px')
    wrapper.unmount()
  })

  it('persists only the unified right rail fields', async () => {
    const { layout } = setup()
    layout.rightRailTab.value = 'links'
    layout.rightRailWidth.value = 420
    await nextTick()
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.rightRailTab).toBe('links')
    expect(stored.rightRailWidth).toBe(420)
    expect(stored).not.toHaveProperty('aiOpen')
    expect(stored).not.toHaveProperty('aiPanelWidth')
    expect(stored).not.toHaveProperty('tocPanelWidth')
  })

  it('persists the left sidebar collapsed state', async () => {
    const { layout } = setup()
    layout.toggleSidePanel()
    await nextTick()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      activePanel: 'files',
      leftSidebarCollapsed: true,
    })
  })

  it('restores the single-file history tab from persisted layout', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rightRailTab: 'history' }))
    const { layout } = setup()
    expect(layout.rightRailTab.value).toBe('history')
  })

  it('hides the retired persistent recovery panel while retaining old layouts', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activePanel: 'recovery' }))
    const { layout } = setup()
    expect(layout.activePanel.value).toBeNull()
    expect(layout.sidePanelOpen.value).toBe(false)
  })

  it('shares the selected tab across consumers', () => {
    const first = setup().layout
    const second = setup().layout
    first.rightRailTab.value = 'ai'
    expect(second.rightRailTab.value).toBe('ai')
  })

  it('drops unknown fields from persisted layout (forward-compat with old previewOpen)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      rightRailTab: 'toc',
      rightRailWidth: 380,
      rightRailCollapsed: false,
      previewOpen: true, // legacy field from before Preview was removed
    }))
    __resetVaultLayoutState()
    const { layout } = setup()
    // No crash; the legacy field is simply ignored.
    expect(layout.rightRailTab.value).toBe('toc')
    expect(layout.rightRailWidth.value).toBe(380)
    // And it never re-emerges when the layout is rewritten. The
    // persistence watcher only fires on real mutations, so toggle a tab
    // and await a tick to flush the rewrite.
    layout.rightRailTab.value = 'ai'
    await nextTick()
    expect(localStorage.getItem(STORAGE_KEY)!).not.toContain('previewOpen')
  })
})
