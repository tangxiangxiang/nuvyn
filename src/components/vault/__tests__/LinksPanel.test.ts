// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinksPanel from '../LinksPanel.vue'
import { useI18n } from '../../../composables/useI18n'
import { __resetFallbackFileChangesForTesting, getFallbackVaultFileChanges } from '../../../composables/vault/context/fileChanges'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('LinksPanel', () => {
  beforeEach(() => {
    useI18n().setLocale('zh')
    __resetFallbackFileChangesForTesting()
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

  it('does not allow a slower old-path backlinks request to replace the current path', async () => {
    const a = deferred<Array<{ source: string }>>()
    const b = deferred<Array<{ source: string }>>()
    mocks.fetchBacklinks.mockReset().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts } })

    await wrapper.setProps({ path: 'inbox/english/object' })
    b.resolve([{ source: 'inbox/b-source' }])
    await flushPromises()
    expect(wrapper.text()).toContain('b-source')

    a.resolve([{ source: 'archive/a-source' }])
    await flushPromises()
    expect(wrapper.text()).toContain('b-source')
    expect(wrapper.text()).not.toContain('a-source')
    wrapper.unmount()
  })

  it('clears old backlinks on path switch even when the new request fails', async () => {
    const b = deferred<Array<{ source: string }>>()
    mocks.fetchBacklinks.mockReset()
      .mockResolvedValueOnce([{ source: 'archive/grammar/predicate' }])
      .mockReturnValueOnce(b.promise)
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts } })
    await flushPromises()
    expect(wrapper.text()).toContain('英语-谓语')

    await wrapper.setProps({ path: 'inbox/english/object' })
    expect(wrapper.text()).not.toContain('英语-谓语')
    b.reject(new Error('temporary network failure'))
    await flushPromises()
    expect(wrapper.text()).not.toContain('英语-谓语')
    wrapper.unmount()
  })

  it('invalidates a pending request when there is no active path', async () => {
    const a = deferred<Array<{ source: string }>>()
    mocks.fetchBacklinks.mockReset().mockReturnValueOnce(a.promise)
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts } })

    await wrapper.setProps({ path: null })
    a.resolve([{ source: 'archive/a-source' }])
    await flushPromises()

    expect(wrapper.text()).not.toContain('a-source')
    expect(wrapper.text()).toContain('打开文档后查看引用关系')
    wrapper.unmount()
  })

  it('keeps current backlinks after a same-path background refresh fails', async () => {
    vi.useFakeTimers()
    mocks.fetchBacklinks.mockReset()
      .mockResolvedValueOnce([{ source: 'archive/grammar/predicate' }])
      .mockRejectedValueOnce(new Error('temporary network failure'))
    const wrapper = mount(LinksPanel, { props: { path: 'inbox/current', posts } })
    await flushPromises()
    expect(wrapper.text()).toContain('英语-谓语')

    getFallbackVaultFileChanges().publish({ path: 'another-note.md', kind: 'write' })
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    expect(wrapper.text()).toContain('英语-谓语')
    wrapper.unmount()
    vi.useRealTimers()
  })
})
