// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExcalidrawHost from '../ExcalidrawHost.vue'

const islandMocks = vi.hoisted(() => ({
  mount: vi.fn(),
  update: vi.fn(),
  unmount: vi.fn(),
}))

vi.mock('../../../features/board/engine/excalidraw/reactIsland', () => ({
  mountExcalidrawIsland: islandMocks.mount,
}))

afterEach(() => {
  islandMocks.mount.mockReset()
  islandMocks.update.mockReset()
  islandMocks.unmount.mockReset()
})

describe('ExcalidrawHost', () => {
  it('mounts the lazy Island, updates theme without recreating it, and unmounts it', async () => {
    islandMocks.mount.mockImplementation(async (options: { onReady?: () => void }) => {
      options.onReady?.()
      return {
        update: islandMocks.update,
        unmount: islandMocks.unmount,
      }
    })

    const initialScene = { elements: [], appState: {}, files: {} }
    const wrapper = mount(ExcalidrawHost, { props: { initialScene, theme: 'light' } })
    await flushPromises()

    expect(islandMocks.mount).toHaveBeenCalledOnce()
    expect(islandMocks.mount).toHaveBeenCalledWith(expect.objectContaining({ initialScene }))
    expect(wrapper.emitted('ready')).toHaveLength(1)

    await wrapper.setProps({ theme: 'dark' })
    expect(islandMocks.update).toHaveBeenCalledWith({ theme: 'dark', langCode: 'en' })
    expect(islandMocks.mount).toHaveBeenCalledOnce()

    wrapper.unmount()
    expect(islandMocks.unmount).toHaveBeenCalledOnce()
  })

  it('bridges runtime assets without turning them into canvas errors', async () => {
    islandMocks.mount.mockImplementation(async (options: { onAssetsChanged?: (assets: unknown[]) => void }) => {
      options.onAssetsChanged?.([{ engineFileId: 'file-1', mimeType: 'image/png', blob: new Blob(['image']) }])
      return { update: islandMocks.update, unmount: islandMocks.unmount }
    })

    const wrapper = mount(ExcalidrawHost, { props: { initialScene: { elements: [], appState: {}, files: {} } } })
    await flushPromises()

    expect(wrapper.emitted('assetsChanged')).toEqual([[[{ engineFileId: 'file-1', mimeType: 'image/png', blob: expect.any(Blob) }]]])
    expect(wrapper.emitted('error')).toBeUndefined()
    wrapper.unmount()
  })

  it('bridges Library persistence failures to the UI boundary', async () => {
    const error = new Error('IndexedDB unavailable')
    islandMocks.mount.mockImplementation(async (options: { onLibrarySaveError?: (error: unknown) => void }) => {
      options.onLibrarySaveError?.(error)
      return { update: islandMocks.update, unmount: islandMocks.unmount }
    })

    const wrapper = mount(ExcalidrawHost, { props: { initialScene: { elements: [], appState: {}, files: {} } } })
    await flushPromises()

    expect(wrapper.emitted('librarySaveError')).toEqual([[error]])
    wrapper.unmount()
  })
})
