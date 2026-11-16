// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CommandPalette from '../CommandPalette.vue'
import { dispose } from '../../../lib/search'
import type { PostSummary } from '../../../lib/api'
import type { SearchProvider, SearchResult, SearchResultSection } from '../../../lib/searchResults'
import { useI18n } from '../../../composables/useI18n'

const post: PostSummary = { path: 'inbox/redis', title: 'Redis', created: '', updated: '', tags: [], summary: '', size: 0, mtime: 1 }
const secondPost: PostSummary = { path: 'inbox/river', title: 'River', created: '', updated: '', tags: [], summary: '', size: 0, mtime: 1 }

it('keeps Escape dismissal when the global host owns the opening shortcut', async () => {
  const wrapper = mount(CommandPalette, { props: { posts: [], keyboardShortcut: false } })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))
  await flushPromises()
  expect(document.body.querySelector('.palette')).toBeNull()
  ;(wrapper.vm as unknown as { show: () => void }).show()
  await flushPromises()
  expect(document.body.querySelector('.palette')).not.toBeNull()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  expect(document.body.querySelector('.palette')).toBeNull()
  wrapper.unmount()
})

describe('CommandPalette Chinese copy', () => {
  beforeEach(() => { useI18n().setLocale('zh'); dispose(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: '' }) }))) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); dispose(); document.body.innerHTML = '' })

  it('uses a dynamic Chinese placeholder and accessibility labels', async () => {
    const wrapper = mount(CommandPalette, { props: { posts: [post], activePath: null } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    expect(input.placeholder).toBe('搜索 1 篇文档…')
    expect(input.getAttribute('aria-label')).toBe('搜索全部内容')
    expect(document.body.querySelector('.palette')?.getAttribute('aria-label')).toBe('全局搜索')
    wrapper.unmount()
  })

  it('shows Chinese empty, new-document, navigation, and badge copy', async () => {
    const wrapper = mount(CommandPalette, { props: { posts: [post], activePath: null } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    expect(document.body.querySelector('.palette-empty')?.textContent).toContain('输入关键词开始搜索')
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0)
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '不存在'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.body.textContent).toContain('没有找到相关内容'))
    expect(document.body.textContent).toContain('新建“不存在”')
    expect(document.body.textContent).toContain('↑↓ 切换')
    expect(document.body.textContent).toContain('↵ 打开')
    expect(document.body.textContent).toContain('Esc 关闭')

    input.value = 'Redis'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.body.querySelector('.palette-badge')?.textContent).toBe('标题'))
    expect(document.body.querySelector('.palette-section-title')).toBeNull()
    expect(document.body.querySelector('.palette-badge')?.textContent).toBe('标题')

    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('.palette-empty')?.textContent).toContain('输入关键词开始搜索')
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0)
    wrapper.unmount()
  })

  it('renders the same Search UI in English through useI18n', async () => {
    useI18n().setLocale('en')
    const wrapper = mount(CommandPalette, { props: { posts: [post], activePath: null } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    expect(input.placeholder).toBe('Search 1 documents…')
    expect(input.getAttribute('aria-label')).toBe('Search all content')
    expect(document.body.querySelector('.palette')?.getAttribute('aria-label')).toBe('Global search')
    expect(document.body.querySelector('.palette-section-title')).toBeNull()
    expect(document.body.querySelector('.palette-empty')?.textContent).toContain('Start typing to search')
    expect(document.body.querySelector('.palette-badge')).toBeNull()
    wrapper.unmount()
  })

  it('highlights exact Note matches as safe text for case-insensitive and regex-special queries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hit: SearchResult = {
      id: 'file:inbox/search-hit',
      type: 'file',
      title: 'Search Notes',
      score: 1,
      payload: {
        path: 'inbox/search-hit',
        match: 'body',
        bodyQuery: 'a+b',
        snippet: 'body contains A+B and literal <img src=x onerror=alert(1)> text',
      },
    }
    const provider = vi.fn(async (query: string): Promise<SearchResultSection> => ({
      id: 'files', label: 'Files', results: query ? [hit] : [],
    })) as SearchProvider
    const wrapper = mount(CommandPalette, { props: { providers: [provider], allowCreate: false } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()

    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'a+b'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    expect(option.querySelector('.palette-snippet .palette-note-highlight')?.textContent).toBe('A+B')
    expect(option.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(option.querySelector('img')).toBeNull()
    expect(option.querySelector('script')).toBeNull()
    wrapper.unmount()
  })

  it('highlights Chinese keywords in Note titles and body excerpts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const titleHit: SearchResult = {
      id: 'file:inbox/similar-title',
      type: 'file',
      title: '类似的记录',
      score: 1,
      payload: { path: 'inbox/similar-title', match: 'title' },
    }
    const bodyHit: SearchResult = {
      id: 'file:inbox/similar-body',
      type: 'file',
      title: '早餐记录',
      score: 0.1,
      payload: { path: 'inbox/similar-body', match: 'body', bodyQuery: '类似', snippet: '我觉得类似的做法更适合这条记录。' },
    }
    const provider = vi.fn(async (query: string): Promise<SearchResultSection> => ({
      id: 'files', label: 'Files', results: query ? [titleHit, bodyHit] : [],
    })) as SearchProvider
    const wrapper = mount(CommandPalette, { props: { providers: [provider], allowCreate: false } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()

    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '类似'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const options = document.body.querySelectorAll<HTMLElement>('[role="option"]')
    expect(options[0]?.querySelector('.palette-note-title .palette-note-highlight')?.textContent).toBe('类似')
    expect(options[1]?.querySelector('.palette-note-snippet .palette-note-highlight')?.textContent).toBe('类似')
    wrapper.unmount()
  })

  it('renders saved Board body matches with one safe highlighted snippet and no path line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hit: SearchResult = {
      id: 'board:board-1',
      type: 'board',
      title: 'Java 并发',
      score: 0,
      payload: {
        boardId: 'board-1',
        match: 'body',
        revision: 3,
        snippet: '死锁的四个必要条件 a+b <img src=x onerror=alert(1)>',
        elementId: 'text-1',
      },
    }
    const provider = vi.fn(async (query: string): Promise<SearchResultSection> => ({
      id: 'boards', label: 'Boards', results: query ? [hit] : [],
    })) as SearchProvider
    const wrapper = mount(CommandPalette, { props: { providers: [provider], allowCreate: false } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()

    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '死锁'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    expect(option.querySelector('.palette-badge')?.textContent).toBe('正文')
    expect(option.querySelector('.palette-note-highlight')?.textContent).toBe('死锁')
    expect(option.textContent).toContain('a+b <img src=x onerror=alert(1)>')
    expect(option.querySelector('img, script')).toBeNull()
    expect(option.querySelector('.palette-path')).toBeNull()
    wrapper.unmount()
  })

  it('keeps duplicate Note titles free of directory labels while preserving keyboard selection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hits: SearchResult[] = [
      { id: 'file:work/meeting', type: 'file', title: 'Meeting notes', subtitle: 'work/meeting', score: 1, payload: { path: 'work/meeting', match: 'title' } },
      { id: 'file:personal/meeting', type: 'file', title: 'Meeting notes', subtitle: 'personal/meeting', score: 1, payload: { path: 'personal/meeting', match: 'title' } },
    ]
    const provider = vi.fn(async (query: string): Promise<SearchResultSection> => ({
      id: 'files', label: 'Files', results: query ? hits : [],
    })) as SearchProvider
    const wrapper = mount(CommandPalette, { props: { providers: [provider], allowCreate: false } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()

    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'Meeting'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const options = document.body.querySelectorAll<HTMLElement>('[role="option"]')
    expect(options).toHaveLength(2)
    expect(document.body.querySelectorAll('.palette-parent, .palette-path, .palette-note-path-tooltip-content')).toHaveLength(0)
    expect([...options].some((option) => option.textContent?.includes('work/') || option.textContent?.includes('personal/'))).toBe(false)
    expect(input.getAttribute('aria-activedescendant')).toBeNull()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(options[1]?.classList.contains('keyboard-focus')).toBe(true)
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id)
    expect(document.body.querySelectorAll('.palette-parent, .palette-path, .palette-note-path-tooltip-content')).toHaveLength(0)
    wrapper.unmount()
  })

  it('opens from Ctrl+P, focuses search, and preserves listbox keyboard selection', async () => {
    useI18n().setLocale('en')
    const wrapper = mount(CommandPalette, {
      props: { posts: [post, secondPost], activePath: null },
      attachTo: document.body,
    })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    expect(document.activeElement).toBe(input)
    input.value = 'r'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.waitFor(() => expect(document.body.querySelector('[role="listbox"]')).toBeTruthy())
    expect(document.body.querySelector('[role="listbox"]')).toBeTruthy()
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('River')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Redis')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([['inbox/redis']])
    expect(document.body.querySelector('.palette')).toBeNull()
    wrapper.unmount()
  })

  it('debounces provider requests and discards stale results from an older query', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finishOldQuery!: (section: SearchResultSection) => void
    const staleResult: SearchResult = { id: 'old', type: 'board', title: 'stale private result', score: 0, payload: {} }
    const currentResult: SearchResult = { id: 'new', type: 'board', title: 'current result', score: 0, payload: {} }
    const providerMock = vi.fn((query: string) => {
      if (query === 'old query') return new Promise<SearchResultSection>(resolve => { finishOldQuery = resolve })
      return Promise.resolve({ id: 'fixture', label: 'Fixture', results: query ? [currentResult] : [] })
    })
    const provider = providerMock as SearchProvider
    const clearProvider = vi.fn()
    provider.clear = clearProvider
    const wrapper = mount(CommandPalette, { props: { providers: [provider], allowCreate: false } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    providerMock.mockClear()

    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'old query'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(249)
    expect(providerMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(providerMock).toHaveBeenCalledWith('old query')

    input.value = 'new query'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(clearProvider).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(document.body.textContent).toContain('current result')

    finishOldQuery({ id: 'fixture', label: 'Fixture', results: [staleResult] })
    await flushPromises()
    expect(document.body.textContent).not.toContain('stale private result')
    expect(document.body.textContent).toContain('current result')

    wrapper.unmount()
    vi.useRealTimers()
  })

  it('renders Diary search results with a text-only highlighted snippet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hit: SearchResult = {
      id: 'diary:2025-08-12',
      type: 'diary-day',
      title: '2025-08-12',
      score: 0,
      payload: { date: '2025-08-12', entryId: 'entry-uuid', snippet: '早餐吃了南瓜饼', match: 'entry', query: '南瓜饼' },
    }
    const provider = vi.fn(async (query: string): Promise<SearchResultSection> => ({
      id: 'diary', label: '日记', results: query ? [hit] : [],
    })) as SearchProvider
    const wrapper = mount(CommandPalette, { props: { providers: [provider], allowCreate: false } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '南瓜饼'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const result = document.body.querySelector<HTMLElement>('[role="option"]')
    expect(result?.textContent).toContain('2025-08-12')
    expect(result?.querySelector('mark')?.textContent).toBe('南瓜饼')
    expect(document.body.querySelector('.palette-section-label')).toBeNull()
    expect(location.search).not.toContain('南瓜饼')
    wrapper.unmount()
  })

  it('keeps Unicode input, create-new, Escape, and backdrop close behavior', async () => {
    const wrapper = mount(CommandPalette, {
      props: { posts: [], activePath: null },
      attachTo: document.body,
    })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    let input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '新文档'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await vi.waitFor(() => expect(Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .some((button) => button.textContent?.includes('新建“新文档”'))).toBe(true))
    const create = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('新建“新文档”'))!
    create.click()
    await flushPromises()
    expect(wrapper.emitted('new')).toEqual([['新文档']])

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('.palette')).toBeNull()

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    document.body.querySelector<HTMLElement>('.palette-backdrop')?.click()
    await flushPromises()
    expect(document.body.querySelector('.palette')).toBeNull()
    wrapper.unmount()
  })
})
