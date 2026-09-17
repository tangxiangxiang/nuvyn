// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinksPanel from '../LinksPanel.vue'
import { useI18n } from '../../../composables/useI18n'

const mocks = vi.hoisted(() => ({
  index: { value: { paths: [], outgoing: {} as Record<string, Array<{ target: string; kind: 'wiki' }>> } },
  fetchBacklinks: vi.fn(),
}))

vi.mock('../../../composables/vault/useLinkIndex', () => ({
  getLinkIndex: () => mocks.index,
  fetchBacklinks: (...args: unknown[]) => mocks.fetchBacklinks(...args),
}))

const posts = [
  { path: 'inbox/current', title: '当前文档', created: '', updated: '', tags: [], size: 0, mtime: 0 },
  { path: 'archive/grammar/predicate', title: '英语-谓语', created: '', updated: '', tags: [], size: 0, mtime: 0 },
  { path: 'inbox/english/object', title: '英语-宾语', created: '', updated: '', tags: [], size: 0, mtime: 0 },
]

describe('LinksPanel', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    mocks.index.value = { paths: [], outgoing: { 'inbox/current': [{ target: 'inbox/english/object', kind: 'wiki' }] } }
    mocks.fetchBacklinks.mockReset().mockResolvedValue([{ source: 'archive/grammar/predicate' }])
  })
  afterEach(() => useI18n().setLocale('zh'))

  it('renders both relationship groups with secondary paths and navigates rows', async () => {
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts } })
    await flushPromises()
    expect(wrapper.text()).toContain('被引用（1）')
    expect(wrapper.text()).toContain('引用（1）')
    expect(wrapper.findAll('.link-path')).toHaveLength(2)
    expect(wrapper.findAll('.link-entry')[0].attributes('title')).toBe('archive/grammar/predicate')
    await wrapper.findAll('.link-entry')[0].trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['archive/grammar/predicate']])
  })

  it('renders an empty relationship state', async () => {
    mocks.index.value = { paths: [], outgoing: {} }
    mocks.fetchBacklinks.mockResolvedValue([])
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts } })
    await flushPromises()
    expect(wrapper.text()).toContain('暂无引用关系')
  })

  it('shows a compact directory only when titles need disambiguation', async () => {
    const duplicatePosts = [...posts, {
      path: 'inbox/other/predicate', title: '英语-谓语', created: '', updated: '',
      tags: [], size: 0, mtime: 0,
    }]
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts: duplicatePosts } })
    await flushPromises()
    expect(wrapper.find('.link-path').text()).toBe('Archive / grammar')
  })
})
