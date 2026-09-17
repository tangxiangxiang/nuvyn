// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import GlobalSearchHost from '../GlobalSearchHost.vue'
import { boardMetadataSource } from '../../../features/board/metadataSource'
import { documentSearchSource } from '../../../lib/documentSearchSource'
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
