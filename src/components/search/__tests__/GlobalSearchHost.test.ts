// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import GlobalSearchHost from '../GlobalSearchHost.vue'
import { boardMetadataSource } from '../../../features/board/metadataSource'
import { documentSearchSource } from '../../../lib/documentSearchSource'
import { clearSearchReveal, requestSearchReveal, searchRevealIntent } from '../../../composables/useSearchReveal'
import { clearDiarySearchOpen, diarySearchOpenIntent } from '../../../composables/diary/useDiarySearchNavigation'
const api = vi.hoisted(() => ({ searchBoardContent: vi.fn(), listBoards: vi.fn(), listPosts: vi.fn() }))
const diarySearch = vi.hoisted(() => vi.fn())
const diaryEventSearch = vi.hoisted(() => vi.fn())
const diaryTaskSearch = vi.hoisted(() => vi.fn())
const diarySessionState = vi.hoisted(() => ({ unlocked: true, accessRef: null as null | { value: boolean }, teardown: null as null | (() => void) }))
vi.mock('../../../features/board/api', () => api)
vi.mock('../../../lib/api', () => ({ listPosts: api.listPosts }))
vi.mock('../../../lib/diary-life-api', () => ({ diaryLifeApi: { search: diarySearch, searchEvents: diaryEventSearch } }))
vi.mock('../../../lib/diary-tasks-api', () => ({ diaryTasksApi: { searchTasks: diaryTaskSearch } }))
vi.mock('../../../composables/diary/useDiaryAccessSession', async () => {
  const { ref } = await import('vue')
  const isUnlocked = ref(diarySessionState.unlocked)
  diarySessionState.accessRef = isUnlocked
  return {
    useDiaryAccessSession: () => ({ isUnlocked }),
    subscribeDiaryTeardown: (listener: () => void) => {
      diarySessionState.teardown = listener
      return () => { diarySessionState.teardown = null }
    },
  }
})

const mountedHosts = new Set<ReturnType<typeof mount>>()
function mountHost(router: Router) {
  const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })
  mountedHosts.add(wrapper)
  return wrapper
}
function unmountHost(wrapper: ReturnType<typeof mount>) {
  mountedHosts.delete(wrapper)
  wrapper.unmount()
}
async function flushSearchDebounce() {
  await flushPromises()
  await vi.advanceTimersByTimeAsync(250)
  await flushPromises()
}

describe('App-level GlobalSearchHost', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.clearAllMocks()
    boardMetadataSource.invalidate()
    documentSearchSource.invalidate()
    clearDiarySearchOpen()
    diarySearch.mockReset()
    diaryEventSearch.mockReset()
    diaryTaskSearch.mockReset()
    diarySessionState.unlocked = true
    if (diarySessionState.accessRef) diarySessionState.accessRef.value = true
  })

  afterEach(() => {
    mountedHosts.forEach(wrapper => wrapper.unmount())
    mountedHosts.clear()
    boardMetadataSource.invalidate()
    documentSearchSource.invalidate()
    clearSearchReveal()
    clearDiarySearchOpen()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('navigates a Board result to the thin Board Editor route from Board workspace', async () => {
    api.searchBoardContent.mockResolvedValue({ items: [
      { boardId: 'atlas', title: 'Project Atlas', match: 'title', revision: 0, updatedAt: 1 },
    ] })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/board',
          name: 'board',
          component: { template: '<div />' },
          meta: { workspace: true, chromeStyle: 'workspace' },
        },
        { path: '/board/:boardId', name: 'board-editor', component: { template: '<div />' } },
      ],
    })
    await router.push('/board')
    await router.isReady()
    requestSearchReveal({ path: 'inbox/old', text: 'old body query' })
    const wrapper = mountHost(router)

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'atlas'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()

    const result = document.body.querySelector<HTMLElement>('[role="option"]')
    expect(result?.textContent).toContain('Project Atlas')
    result?.click()
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(router.currentRoute.value.params.boardId).toBe('atlas')
    expect(searchRevealIntent.value).toBeNull()
    unmountHost(wrapper)
  })

  it('creates a transient reveal intent before navigating a body result', async () => {
    api.listPosts.mockResolvedValue([{
      path: 'inbox/engineering-guide', title: 'Engineering Guide', created: '', updated: '', tags: [], size: 0, mtime: 1,
    }])
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: 'Transaction isolation levels explained here.' }),
    })))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/vault', name: 'vault', component: { template: '<div />' },
          meta: { workspace: true, workspaceKind: 'vault', chromeStyle: 'workspace' },
        },
        { path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } },
      ],
    })
    let intentAtNavigation: typeof searchRevealIntent.value = null
    router.beforeEach((to) => {
      if (to.name === 'vault-doc') intentAtNavigation = searchRevealIntent.value
      return true
    })
    await router.push('/vault')
    await router.isReady()
    const wrapper = mountHost(router)

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'transaction isolation'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()
    await vi.waitFor(() => expect(document.body.querySelector('.palette-snippet')?.textContent).toContain('Transaction isolation'))
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Engineering Guide')
    document.body.querySelector<HTMLElement>('[role="option"]')?.click()
    await flushPromises()

    expect(intentAtNavigation).toMatchObject({ path: 'inbox/engineering-guide', text: 'transaction isolation' })
    expect(router.currentRoute.value.name).toBe('vault-doc')
    expect(searchRevealIntent.value).toEqual(intentAtNavigation)
    unmountHost(wrapper)
  })

  it('clears a stale reveal before navigating a metadata result', async () => {
    api.listPosts.mockResolvedValue([{
      path: 'inbox/redis', title: 'Redis Guide', created: '', updated: '', tags: [], size: 0, mtime: 1,
    }])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: '' }) })))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/vault', name: 'vault', component: { template: '<div />' },
          meta: { workspace: true, workspaceKind: 'vault', chromeStyle: 'workspace' },
        },
        { path: '/vault/:pathMatch(.*)*', name: 'vault-doc', component: { template: '<div />' } },
      ],
    })
    let intentAtNavigation: typeof searchRevealIntent.value = null
    router.beforeEach((to) => {
      if (to.name === 'vault-doc') intentAtNavigation = searchRevealIntent.value
      return true
    })
    await router.push('/vault')
    await router.isReady()
    requestSearchReveal({ path: 'inbox/old', text: 'stale query' })
    const wrapper = mountHost(router)

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'Redis'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()
    const result = document.body.querySelector<HTMLElement>('[role="option"]')
    expect(result?.textContent).toContain('Redis Guide')
    result?.click()
    await flushPromises()

    expect(intentAtNavigation).toBeNull()
    expect(router.currentRoute.value.name).toBe('vault-doc')
    expect(searchRevealIntent.value).toBeNull()
    unmountHost(wrapper)
  })

  it('loads Document results on the Vault workspace route', async () => {
    api.listPosts.mockResolvedValue([{
      path: 'inbox/atlas', title: 'Project Atlas', created: '', updated: '', tags: [], size: 0, mtime: 1,
    }])
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/:workspace',
        name: 'workspace',
        component: { template: '<div />' },
        meta: { workspace: true, chromeStyle: 'workspace' },
      }],
    })
    await router.push('/vault')
    await router.isReady()
    const wrapper = mountHost(router)

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'atlas'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()

    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Project Atlas')
    expect(api.searchBoardContent).not.toHaveBeenCalled()
    expect(api.listPosts).toHaveBeenCalledOnce()
    unmountHost(wrapper)
  })

  it('does not mix Document results into the Board workspace', async () => {
    api.searchBoardContent.mockResolvedValue({ items: [] })
    api.listPosts.mockResolvedValue([{
      path: 'inbox/atlas', title: 'Project Atlas', created: '', updated: '', tags: [], size: 0, mtime: 1,
    }])
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/:workspace',
        name: 'workspace',
        component: { template: '<div />' },
        meta: { workspace: true, chromeStyle: 'workspace' },
      }],
    })
    await router.push('/board')
    await router.isReady()
    const wrapper = mountHost(router)

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'atlas'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()
    expect(document.body.querySelector('.palette-empty')?.textContent).toContain('No matching results')

    expect(document.body.querySelector('[role="option"]')).toBeNull()
    expect(api.searchBoardContent).toHaveBeenCalledOnce()
    expect(api.listPosts).not.toHaveBeenCalled()
    unmountHost(wrapper)
  })

  it('does not open the global search on Ledger workspace', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/:workspace',
        name: 'workspace',
        component: { template: '<div />' },
        meta: { workspace: true, chromeStyle: 'workspace' },
      }],
    })
    await router.push('/ledger')
    await router.isReady()
    const wrapper = mountHost(router)

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()

    expect(document.body.querySelector('.palette')).toBeNull()
    unmountHost(wrapper)
  })

  it('searches Diary only while unlocked and opens a result through a transient navigation intent', async () => {
    diarySearch.mockResolvedValue({
      items: [{ date: '2025-08-12', entryId: 'entry-uuid', snippet: '回忆到南瓜饼', match: 'entry' }],
      nextCursor: null,
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/diary', name: 'diary', component: { template: '<div />' }, meta: { workspace: true, workspaceKind: 'diary', chromeStyle: 'workspace' } }],
    })
    await router.push('/diary')
    await router.isReady()
    const wrapper = mountHost(router)
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '南瓜饼'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()

    expect(api.searchBoardContent).not.toHaveBeenCalled()
    expect(api.listPosts).not.toHaveBeenCalled()
    expect(diarySearch).toHaveBeenCalledWith('南瓜饼', 20, null, expect.any(AbortSignal))
    expect(document.body.querySelector('.palette-item')?.textContent).toContain('回忆到南瓜饼')
    document.body.querySelector<HTMLElement>('[role="option"]')?.click()
    await flushPromises()

    expect(diarySearchOpenIntent.value).toMatchObject({ date: '2025-08-12', entryId: 'entry-uuid' })
    expect(document.body.querySelector('.palette')).toBeNull()
    unmountHost(wrapper)
  })

  it('clears private Diary results immediately when the access session locks', async () => {
    diarySearch.mockResolvedValue({ items: [{ date: '2026-11-15', snippet: 'private diary snippet', match: 'entry', entryIndex: 0 }], nextCursor: null })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/diary', name: 'diary', component: { template: '<div />' }, meta: { workspace: true, workspaceKind: 'diary', chromeStyle: 'workspace' } }],
    })
    await router.push('/diary')
    await router.isReady()
    const wrapper = mountHost(router)
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'private'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()
    expect(document.body.querySelector('.palette-item')?.textContent).toContain('private diary snippet')

    diarySessionState.accessRef!.value = false
    await flushPromises()
    expect(document.body.querySelector('.palette')).toBeNull()
    expect(document.body.textContent).not.toContain('private diary snippet')
    expect(diarySearchOpenIntent.value).toBeNull()
    unmountHost(wrapper)
  })

  it('groups Event and Todo hits and creates precise Diary navigation intents', async () => {
    diarySearch.mockResolvedValue({ items: [], nextCursor: null })
    diaryEventSearch.mockResolvedValue({ items: [{
      id: 'event-uuid', title: '买下第一套房', emoji: '🏠', type: 'milestone', targetDate: '2025-08-16',
      subtitle: '人生时刻 · 2025-08-16', snippet: '', match: 'title',
    }], nextCursor: null })
    diaryTaskSearch.mockResolvedValue({ items: [{
      id: 'task-uuid', kind: 'one-off', targetDate: '2025-08-20', title: '联系中介', completedAt: null,
      snippet: '', match: 'title',
    }], nextCursor: null })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/diary', name: 'diary', component: { template: '<div />' }, meta: { workspace: true, workspaceKind: 'diary', chromeStyle: 'workspace' } }],
    })
    await router.push('/diary')
    await router.isReady()
    const wrapper = mountHost(router)
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '买房'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushSearchDebounce()
    expect([...document.body.querySelectorAll('.palette-section-label')].map(label => label.textContent)).toEqual(['事件', '待办'])
    expect(diaryEventSearch).toHaveBeenLastCalledWith('买房', 20, null, expect.any(AbortSignal))
    expect(diaryTaskSearch).toHaveBeenLastCalledWith('买房', 20, null, expect.any(AbortSignal))

    document.body.querySelector<HTMLElement>('[role="option"]')?.click()
    await flushPromises()
    expect(diarySearchOpenIntent.value).toMatchObject({ kind: 'event', eventId: 'event-uuid', date: '2025-08-16' })
    expect(document.body.querySelector('.palette')).toBeNull()
    unmountHost(wrapper)
  })
})
