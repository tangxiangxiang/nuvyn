// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import RightRail from '../RightRail.vue'
import { tocActiveId, tocHeadings, tocScrollTo } from '../../../composables/vault/useTocState'
import type { RightRailTab } from '../../../composables/vault/useVaultLayout'
import { useI18n } from '../../../composables/useI18n'
import type { FileHistoryState } from '../../../composables/vault/useFileHistory'

const posts = [{
  path: 'inbox/english/subject', title: '英语-主语', created: '', updated: '',
  tags: [], size: 0, mtime: 0,
}]

function mountPanel(activeTab: RightRailTab = 'toc', isReadMode = true) {
  return mount(RightRail, {
    props: { path: 'inbox/english/subject', posts, activeTab, isReadMode },
    global: {
      stubs: {
        LinksPanel: {
          emits: ['navigate'],
          template: '<button class="stub-link" @click="$emit(\'navigate\', \'archive/target\')">引用</button>',
        },
        AiPanel: { template: '<div class="stub-ai"><input value="draft"></div>' },
        DocumentMetadataForm: {
          emits: ['saved'],
          props: ['readonly', 'context', 'summarySource'],
          template: '<div class="stub-metadata-form" :data-readonly="readonly" :data-context="context" :data-summary-source="summarySource">属性表单</div>',
        },
      },
    },
  })
}

describe('unified document sidebar', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    tocHeadings.value = [
      { id: 'definition', text: '基本定义', level: 2 },
      { id: 'example', text: '例句', level: 3 },
    ]
    tocActiveId.value = 'example'
    tocScrollTo.value = vi.fn()
  })
  afterEach(() => useI18n().setLocale('zh'))

  it('renders TOC as the controlled default view', () => {
    const wrapper = mountPanel()
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('目录')
    expect(wrapper.find('.toc-panel-item.active').text()).toBe('例句')
  })

  it('only renders the first three heading levels', () => {
    tocHeadings.value = [
      { id: 'intro', text: '介绍', level: 1 },
      { id: 'details', text: '详情', level: 2 },
      { id: 'example', text: '例句', level: 3 },
      { id: 'note', text: '补充说明', level: 4 },
    ]
    const wrapper = mountPanel()
    expect(wrapper.findAll('.toc-panel-item').map((item) => item.text())).toEqual(['介绍', '详情', '例句'])
    expect(wrapper.text()).not.toContain('补充说明')
  })

  it('renders tabs in 助手 → 目录 → 引用 → 属性 → 历史 order', () => {
    const wrapper = mountPanel()
    const labels = wrapper.findAll('[role="tab"]').map((tab) => tab.text())
    expect(labels).toEqual(['助手', '目录', '引用', '属性', '历史'])
  })

  it('emits update:activeTab with the matching key for each tab', async () => {
    const wrapper = mountPanel()
    const tabs = wrapper.findAll('[role="tab"]')
    await tabs[0].trigger('click')
    await tabs[1].trigger('click')
    await tabs[2].trigger('click')
    await tabs[3].trigger('click')
    await tabs[4].trigger('click')
    expect(wrapper.emitted('update:activeTab')).toEqual([['ai'], ['toc'], ['links'], ['properties'], ['history']])
  })

  it('reflects the controlled activeTab via aria-selected and the .active class', async () => {
    const wrapper = mountPanel('toc')
    expect(wrapper.get('[role="tab"]:nth-of-type(2)').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[role="tab"]:nth-of-type(2)').classes()).toContain('active')

    await wrapper.setProps({ activeTab: 'ai' })
    expect(wrapper.get('[role="tab"]:nth-of-type(1)').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[role="tab"]:nth-of-type(1)').classes()).toContain('active')

    await wrapper.setProps({ activeTab: 'links' })
    expect(wrapper.get('[role="tab"]:nth-of-type(3)').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[role="tab"]:nth-of-type(3)').classes()).toContain('active')
  })

  it('mounts AI on first selection and keeps it mounted across later tab switches', async () => {
    const wrapper = mountPanel('ai')
    expect(wrapper.find('.toc-panel').exists()).toBe(true)
    expect(wrapper.find('.links-slot').exists()).toBe(true)
    expect(wrapper.find('.stub-ai').exists()).toBe(true)
    expect(wrapper.get('.ai-slot').isVisible()).toBe(true)
    expect(wrapper.get('.toc-panel').attributes('style')).toContain('display: none')

    await wrapper.setProps({ activeTab: 'links' })
    expect(wrapper.find('.stub-ai').exists()).toBe(true)
  })

  it('keeps AI available in read-only views but defers its mount until selected', async () => {
    const wrapper = mountPanel('toc', true)
    const aiTab = wrapper.findAll('[role="tab"]')[0]!

    expect(aiTab.attributes('disabled')).toBeUndefined()
    expect(aiTab.attributes('aria-disabled')).toBeUndefined()
    expect(wrapper.find('.stub-ai').exists()).toBe(false)
    await aiTab.trigger('click')
    await wrapper.setProps({ activeTab: 'ai' })
    expect(wrapper.find('.stub-ai').exists()).toBe(true)
  })

  it('navigates headings and forwards link navigation', async () => {
    const wrapper = mountPanel()
    await wrapper.find('a[href="#definition"]').trigger('click')
    expect(tocScrollTo.value).toHaveBeenCalledWith('definition')
    await wrapper.setProps({ activeTab: 'links' })
    await wrapper.find('.stub-link').trigger('click')
    expect(wrapper.emitted('link-navigate')).toEqual([['archive/target']])
  })

  it('renders the shared metadata form in the fourth tab', async () => {
    const wrapper = mountPanel('properties')
    expect(wrapper.find('.metadata-slot').exists()).toBe(true)
    expect(wrapper.find('.stub-metadata-form').exists()).toBe(true)
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('属性')
  })

  it('hides the metadata path header when no document is selected', async () => {
    const wrapper = mountPanel('properties')
    await wrapper.setProps({ path: null })
    expect(wrapper.find('.right-rail-path-header').exists()).toBe(false)
  })

  it('passes read-only history context to the metadata form', () => {
    const wrapper = mount(RightRail, {
      props: { path: 'inbox/english/subject', posts, activeTab: 'properties', metadataReadonly: true, metadataContext: 'history' },
      global: { stubs: {
        AiPanel: { template: '<div />' },
        LinksPanel: { template: '<div />' },
        RightRailHistory: { template: '<div />' },
        DocumentMetadataForm: { props: ['readonly', 'context'], template: '<div class="stub-metadata-form" :data-readonly="readonly" :data-context="context" />' },
      } },
    })
    expect(wrapper.get('.stub-metadata-form').attributes('data-readonly')).toBe('true')
    expect(wrapper.get('.stub-metadata-form').attributes('data-context')).toBe('history')
  })

  it('scrolls the active tab into the tab strip after switching', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const wrapper = mountPanel()
    await wrapper.setProps({ activeTab: 'history' })
    await nextTick()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    wrapper.unmount()
  })

  it.each(['properties', 'history'] as RightRailTab[])('scrolls a restored %s tab on initial mount', async (activeTab) => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const wrapper = mountPanel(activeTab)
    await nextTick()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    wrapper.unmount()
  })

  it('renders the single-file history view in the fifth tab', () => {
    const wrapper = mountPanel('history')
    expect(wrapper.find('.history-slot').exists()).toBe(true)
    expect(wrapper.text()).toContain('选择文档后查看历史记录')
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('历史')
  })

  it('loads history on the first click when the target exists but is not loaded yet', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const fileHistory = {
      target: ref({ documentPath: 'inbox/english/subject', documentTitle: '英语-主语' }),
      commits: ref([]),
      dayGroups: ref([]),
      loading: ref(false),
      loaded: ref(false),
      error: ref(null),
      expandedDays: ref(new Set<string>()),
      selectedCommitId: ref(null),
      open,
      refresh: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      toggleDay: vi.fn(),
      expandNewestDay: vi.fn(),
      selectCommit: vi.fn(),
    } as unknown as FileHistoryState
    const wrapper = mount(RightRail, {
      props: { path: 'inbox/english/subject', posts, activeTab: 'toc', fileHistory },
      global: {
        stubs: {
          LinksPanel: { template: '<div />' },
          AiPanel: { template: '<div />' },
          DocumentMetadataForm: { template: '<div />' },
          RightRailHistory: { template: '<div />' },
        },
      },
    })

    await wrapper.get('[data-tab="history"]').trigger('click')

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      documentPath: 'inbox/english/subject',
      documentTitle: '英语-主语',
    })
  })

  it('renders empty TOC without affecting the other tabs', () => {
    tocHeadings.value = []
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('暂无目录')
    expect(wrapper.find('.links-slot').exists()).toBe(true)
    expect(wrapper.find('.ai-slot').exists()).toBe(false)
  })

  it('offers a reading-mode action for an empty edit-mode outline', async () => {
    tocHeadings.value = []
    const wrapper = mountPanel('toc', false)
    expect(wrapper.text()).toContain('编辑模式下暂不生成目录')
    await wrapper.get('.right-rail-empty-action').trigger('click')
    expect(wrapper.emitted('switch-to-read')).toEqual([[]])
  })
})
