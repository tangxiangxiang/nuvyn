// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import BoardEmbed from '../BoardEmbed.vue'
import { useI18n } from '../../../composables/useI18n'
import { BoardApiError, getBoardMetadata } from '../../../features/board/api'
import { boardMetadataSource } from '../../../features/board/boardMetadataSource'
import { loadBoardPreview, type BoardPreview } from '../../../features/board/preview'

vi.mock('../../../features/board/api', async (original) => ({
  ...await original<typeof import('../../../features/board/api')>(),
  getBoardMetadata: vi.fn(),
}))
vi.mock('../../../features/board/preview', () => ({ loadBoardPreview: vi.fn() }))

const id = '8a1c2544-dad0-4f20-a593-7bbc59882921'
const nextId = '8a1c2544-dad0-4f20-a593-7bbc59882922'
const createObjectURL = vi.fn(() => 'blob:board-preview')
const revokeObjectURL = vi.fn()
let wrapper: VueWrapper | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function preview(updatedAt = 2, image: Blob | null = new Blob(['<svg />'], { type: 'image/svg+xml' })): BoardPreview {
  return {
    metadata: { id, title: 'Saved diagram', folderId: null, thumbnailAssetId: null, createdAt: 1, updatedAt, lastOpenedAt: null },
    revision: updatedAt, image,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  class PreviewURL extends URL {}
  Object.assign(PreviewURL, { createObjectURL, revokeObjectURL })
  vi.stubGlobal('URL', PreviewURL)
  createObjectURL.mockReturnValue('blob:board-preview')
  vi.mocked(loadBoardPreview).mockReset().mockResolvedValue(preview())
  vi.mocked(getBoardMetadata).mockReset().mockResolvedValue(preview().metadata)
  boardMetadataSource.invalidate()
  useI18n().setLocale('en')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  boardMetadataSource.invalidate()
  useI18n().setLocale('zh')
})

describe('Board embeds', () => {
  it('loads multiple embeds once and does not re-export unchanged scenes on polling', async () => {
    wrapper = mount(defineComponent({ setup: () => () => h('article', [
      h(BoardEmbed, { boardId: id }), h(BoardEmbed, { boardId: nextId }),
    ]) }))
    await flushPromises()
    for (const img of wrapper.findAll('img')) await img.trigger('load')
    expect(loadBoardPreview).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getBoardMetadata).toHaveBeenCalledTimes(4)
    expect(loadBoardPreview).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    wrapper = undefined
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears a previous image immediately and fences consecutive delayed Board switches', async () => {
    createObjectURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:last')
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    const middle = deferred<BoardPreview>()
    const last = deferred<BoardPreview>()
    vi.mocked(loadBoardPreview).mockReturnValueOnce(middle.promise).mockReturnValueOnce(last.promise)
    await wrapper.setProps({ boardId: nextId })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first')
    const middleSignal = vi.mocked(loadBoardPreview).mock.calls[1]![1]!
    await wrapper.setProps({ boardId: id })
    expect(middleSignal.aborted).toBe(true)
    last.resolve(preview(8))
    await flushPromises()
    middle.resolve({ ...preview(7), metadata: { ...preview(7).metadata, title: 'Obsolete' } })
    await flushPromises()
    expect(wrapper.get('img').attributes('alt')).toBe('Saved diagram')
    expect(wrapper.get('img').attributes('src')).toBe('blob:last')
    expect(wrapper.attributes('data-board-revision')).toBe('8')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('keeps the old image during same-Board refresh but ignores its late image events', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    const pending = deferred<BoardPreview>()
    vi.mocked(loadBoardPreview).mockReturnValueOnce(pending.promise)
    boardMetadataSource.upsert(preview(3).metadata)
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(true)
    await wrapper.get('img').trigger('load')
    await wrapper.get('img').trigger('error')
    expect(wrapper.attributes('data-board-state')).toBe('pending')
    pending.reject(new Error('Offline'))
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.attributes('data-board-state')).toBe('error')
    await wrapper.get('.board-embed-retry').trigger('click')
    await flushPromises()
    await wrapper.get('img').trigger('load')
    expect(wrapper.attributes('data-board-state')).toBe('ready')
  })

  it('recovers from an SVG image load failure by rendering a new URL', async () => {
    createObjectURL.mockReturnValueOnce('blob:broken').mockReturnValueOnce('blob:recovered')
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('error')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:broken')
    expect(wrapper.text()).toContain('Reload')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    await wrapper.get('img').trigger('load')
    expect(wrapper.attributes('data-board-state')).toBe('ready')
    expect(wrapper.get('img').attributes('src')).toBe('blob:recovered')
  })

  it('does not allocate URLs for responses arriving after unmount', async () => {
    const pending = deferred<BoardPreview>()
    vi.mocked(loadBoardPreview).mockReturnValueOnce(pending.promise)
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    const signal = vi.mocked(loadBoardPreview).mock.calls[0]![1]!
    wrapper.unmount()
    wrapper = undefined
    pending.resolve(preview())
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a cancelled metadata request cannot block polling for a newly selected Board', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    const pending = deferred<BoardPreview['metadata']>()
    vi.mocked(getBoardMetadata).mockReturnValueOnce(pending.promise)
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    const signal = vi.mocked(getBoardMetadata).mock.calls[0]![1]!
    await wrapper.setProps({ boardId: nextId })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getBoardMetadata).toHaveBeenCalledTimes(2)
    pending.reject(new BoardApiError('Gone', 404))
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.attributes('data-board-state')).toBe('ready')
  })

  it.each([new Error('Network disconnected'), new BoardApiError('Server error', 500)])('clears inaccessible previews and allows retry: %s', async error => {
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    vi.mocked(getBoardMetadata).mockRejectedValueOnce(error)
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.attributes('data-board-state')).toBe('error')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    await wrapper.get('img').trigger('load')
    expect(wrapper.attributes('data-board-state')).toBe('ready')
  })

  it('shows a linked SVG image and settles only when the image loads', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id, label: 'Old title' } })
    await flushPromises()
    expect(wrapper.get('.board-embed').attributes('data-board-state')).toBe('pending')
    expect(wrapper.get('img').attributes('src')).toBe('blob:board-preview')
    expect(wrapper.get('img').attributes('alt')).toBe('Saved diagram')
    expect(wrapper.get('.board-embed-preview').attributes('href')).toBe(`/board/${id}`)
    expect(wrapper.get('.board-embed-preview').attributes('title')).toBe('Open Board to edit')
    expect(wrapper.find('.board-embed-caption').exists()).toBe(false)
    expect(wrapper.find('.board-embed-retry').exists()).toBe(false)
    await wrapper.get('img').trigger('load')
    expect(wrapper.get('.board-embed').attributes('data-board-state')).toBe('ready')
  })

  it('keeps empty and deleted Boards understandable instead of showing a broken image', async () => {
    vi.mocked(loadBoardPreview).mockResolvedValueOnce(preview(2, null))
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    expect(wrapper.text()).toContain('This Board is empty')
    expect(wrapper.get('.board-embed').attributes('data-board-state')).toBe('ready')
    vi.mocked(getBoardMetadata).mockRejectedValueOnce(new BoardApiError('Missing', 404))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(wrapper.text()).toContain('does not exist or has been deleted')
    expect(wrapper.get('.board-embed').attributes('data-board-state')).toBe('error')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.get('.board-embed-retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(true)
  })

  it('refreshes saved revisions on focus and polls metadata without re-exporting unchanged scenes', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getBoardMetadata).toHaveBeenCalledOnce()
    expect(loadBoardPreview).toHaveBeenCalledOnce()
    vi.mocked(getBoardMetadata).mockResolvedValueOnce(preview(3).metadata)
    vi.mocked(loadBoardPreview).mockResolvedValueOnce(preview(3))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(loadBoardPreview).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.board-embed').attributes('data-board-revision')).toBe('3')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:board-preview')
  })

  it('responds to same-session saves and stops polling while the tab is hidden', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    vi.mocked(loadBoardPreview).mockResolvedValueOnce(preview(4))
    boardMetadataSource.upsert(preview(4).metadata)
    await flushPromises()
    expect(wrapper.get('.board-embed').attributes('data-board-revision')).toBe('4')
    await wrapper.get('img').trigger('load')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getBoardMetadata).not.toHaveBeenCalled()
  })

  it('does not let a late response for another Board overwrite the current preview', async () => {
    let resolve!: (value: BoardPreview) => void
    vi.mocked(loadBoardPreview).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    const oldSignal = vi.mocked(loadBoardPreview).mock.calls[0]![1]!
    await wrapper.setProps({ boardId: nextId })
    await flushPromises()
    expect(oldSignal.aborted).toBe(true)
    resolve({ ...preview(), metadata: { ...preview().metadata, title: 'Stale title' } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Stale title')
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('aborts unfinished loads, revokes image URLs, and removes timers on unmount', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id } })
    await flushPromises()
    const signal = vi.mocked(loadBoardPreview).mock.calls[0]![1]!
    wrapper.unmount()
    wrapper = undefined
    expect(signal.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:board-preview')
    await vi.advanceTimersByTimeAsync(30_000)
    window.dispatchEvent(new Event('focus'))
    expect(getBoardMetadata).not.toHaveBeenCalled()
  })

  it('does not start background refreshes for the PDF snapshot surface', async () => {
    wrapper = mount(BoardEmbed, { props: { boardId: id, renderTheme: 'light' } })
    await flushPromises()
    await wrapper.get('img').trigger('load')
    await vi.advanceTimersByTimeAsync(30_000)
    window.dispatchEvent(new Event('focus'))
    expect(getBoardMetadata).not.toHaveBeenCalled()
  })
})
