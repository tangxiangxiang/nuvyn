// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import GlobalSearchHost from '../GlobalSearchHost.vue'
import { boardMetadataSource } from '../../../features/board/metadataSource'
import { documentSearchSource } from '../../../lib/documentSearchSource'
import { clearSearchReveal, requestSearchReveal, searchRevealIntent } from '../../../composables/useSearchReveal'
import type { BoardMetadata } from '../../../../shared/boardProtocol'

const api = vi.hoisted(() => ({ listBoards: vi.fn(), listPosts: vi.fn() }))
vi.mock('../../../features/board/api', () => api)
vi.mock('../../../lib/api', () => ({ listPosts: api.listPosts }))

function board(id: string, title: string): BoardMetadata {
  return { id, title, thumbnailAssetId: null, folderId: null, createdAt: 1, updatedAt: 1, lastOpenedAt: null }
}

describe('App-level GlobalSearchHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    boardMetadataSource.invalidate()
    documentSearchSource.invalidate()
  })

  afterEach(() => {
    boardMetadataSource.invalidate()
    documentSearchSource.invalidate()
    clearSearchReveal()
    document.body.innerHTML = ''
  })

  it('navigates a Board result to the thin Board Editor route from Board workspace', async () => {
    api.listBoards.mockResolvedValue([board('atlas', 'Project Atlas')])
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
    const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'atlas'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Project Atlas')
    ;(document.body.querySelector('[role="option"]') as HTMLElement).click()
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('board-editor')
    expect(router.currentRoute.value.params.boardId).toBe('atlas')
    expect(searchRevealIntent.value).toBeNull()
    wrapper.unmount()
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
    const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'transaction isolation'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.body.querySelector('.palette-snippet')?.textContent).toContain('Transaction isolation'))
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Engineering Guide')
    ;(document.body.querySelector('[role="option"]') as HTMLElement).click()
    await flushPromises()

    expect(intentAtNavigation).toMatchObject({ path: 'inbox/engineering-guide', text: 'transaction isolation' })
    expect(router.currentRoute.value.name).toBe('vault-doc')
    expect(searchRevealIntent.value).toEqual(intentAtNavigation)
    wrapper.unmount()
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
    const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'Redis'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    ;(document.body.querySelector('[role="option"]') as HTMLElement).click()
    await flushPromises()

    expect(intentAtNavigation).toBeNull()
    expect(router.currentRoute.value.name).toBe('vault-doc')
    expect(searchRevealIntent.value).toBeNull()
    wrapper.unmount()
  })

  it('loads Document results on the Vault workspace route', async () => {
    api.listBoards.mockResolvedValue([board('atlas-board', 'Project Atlas')])
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
    const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'atlas'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain('Project Atlas')
    expect(api.listBoards).not.toHaveBeenCalled()
    expect(api.listPosts).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('does not mix Document results into the Board workspace', async () => {
    api.listBoards.mockResolvedValue([])
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
    const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = 'atlas'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(document.body.querySelector('[role="option"]')).toBeNull()
    expect(api.listPosts).not.toHaveBeenCalled()
    wrapper.unmount()
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
    const wrapper = mount(GlobalSearchHost, { global: { plugins: [router] } })

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()

    expect(document.body.querySelector('.palette')).toBeNull()
    wrapper.unmount()
  })
})
