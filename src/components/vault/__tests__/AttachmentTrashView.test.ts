// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInput } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AttachmentTrashView from '../AttachmentTrashView.vue'
import type { AttachmentTrashItem, AttachmentTrashPage } from '../../../../shared/attachmentProtocol'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../../../lib/attachments-api', () => ({
  listAttachmentTrash: mocks.list,
  restoreAttachment: mocks.restore,
}))
vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}))
vi.mock('../AttachmentImagePreview.vue', () => ({
  default: { props: ['item'], template: '<div class="attachment-image-preview" />' },
}))

const ID = '550e8400-e29b-41d4-a716-446655440000'
let wrapper: VueWrapper | undefined

function trashPage(state: AttachmentTrashItem['state'] = 'trashed'): AttachmentTrashPage {
  return {
    items: [{ id: ID, path: `attachments/images/${ID}.png`, resourceId: ID,
      mimeType: 'image/png', byteSize: 100, sha256: 'a'.repeat(64), recycledAt: 1_700_000_000_000, state }],
    total: 1, knownBytes: 100, offset: 0, limit: 30,
  }
}
function emptyPage(): AttachmentTrashPage {
  return { items: [], total: 0, knownBytes: 0, offset: 0, limit: 30 }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}
async function select(state: AttachmentTrashItem['state'] = 'trashed'): Promise<VueWrapper> {
  mocks.list.mockResolvedValue(trashPage(state))
  wrapper = mount(AttachmentTrashView)
  await flushPromises()
  await wrapper.get('.trash-list button').trigger('click')
  return wrapper
}
function restoreButton(view: VueWrapper) {
  return view.get('.trash-detail').getComponent(NButton)
}
// Emit directly to verify the handler's guard independently of disabled DOM
// behavior (for example, an event queued before a loading/state change).
async function emitRestore(view: VueWrapper): Promise<void> {
  restoreButton(view).vm.$emit('click')
  await flushPromises()
}

describe('AttachmentTrashView restore eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockReset()
    mocks.restore.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  it('allows trashed items and refreshes the list and emits changed after successful restore', async () => {
    const view = await select()
    expect(restoreButton(view).props('disabled')).toBe(false)
    expect(view.get('.trash-detail button').attributes('disabled')).toBeUndefined()
    mocks.list.mockResolvedValueOnce(emptyPage())
    await view.get('.trash-detail button').trigger('click')
    await flushPromises()
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(ID)
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.list.mock.calls[1]).toEqual(['', 0, expect.any(AbortSignal)])
    expect(mocks.success).toHaveBeenCalledOnce()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(view.emitted('changed')).toHaveLength(1)
    expect(view.emitted('storage')?.at(-1)).toEqual([0])
    expect(view.find('.trash-detail').exists()).toBe(false)
  })

  it.each(['recycling', 'restoring', 'blocked'] as const)('keeps %s visible but disables and defensively rejects restore', async (state) => {
    const view = await select(state)
    expect(view.get('.trash-path').text()).toContain(ID)
    expect(view.get('.trash-detail').text()).toMatch(/尚待协调|awaits reconciliation/)
    expect(restoreButton(view).props('disabled')).toBe(true)
    expect(view.get('.trash-detail button').attributes('disabled')).toBeDefined()
    await emitRestore(view)
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(view.emitted('changed')).toBeUndefined()
  })

  it('disables and defensively rejects restore while refreshing the page', async () => {
    vi.useFakeTimers()
    const view = await select()
    const refresh = deferred<AttachmentTrashPage>()
    mocks.list.mockReturnValueOnce(refresh.promise)
    view.getComponent(NInput).vm.$emit('update:value', 'image')
    await vi.advanceTimersByTimeAsync(180)
    expect(restoreButton(view).props('disabled')).toBe(true)
    await emitRestore(view)
    expect(mocks.restore).not.toHaveBeenCalled()
    refresh.resolve(trashPage())
    await flushPromises()
    expect(restoreButton(view).props('disabled')).toBe(false)
  })

  it('keeps restore disabled during an in-flight request and rejects duplicate submission', async () => {
    const view = await select()
    const pending = deferred<void>()
    mocks.restore.mockReturnValueOnce(pending.promise)
    await view.get('.trash-detail button').trigger('click')
    expect(restoreButton(view).props()).toMatchObject({ disabled: true, loading: true })
    await emitRestore(view)
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(ID)
    expect(view.emitted('changed')).toBeUndefined()
    mocks.list.mockResolvedValueOnce(emptyPage())
    pending.resolve(undefined)
    await flushPromises()
    expect(view.emitted('changed')).toHaveLength(1)
  })

  it('clears busy after a failed request, refreshes and allows a normal retry', async () => {
    const view = await select()
    mocks.restore.mockRejectedValueOnce(new Error('restore conflict'))
    await view.get('.trash-detail button').trigger('click')
    await flushPromises()
    expect(mocks.error).toHaveBeenCalledOnce()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(view.emitted('changed')).toBeUndefined()
    expect(restoreButton(view).props()).toMatchObject({ disabled: false, loading: false })
    mocks.list.mockResolvedValueOnce(emptyPage())
    await view.get('.trash-detail button').trigger('click')
    await flushPromises()
    expect(mocks.restore).toHaveBeenCalledTimes(2)
    expect(mocks.success).toHaveBeenCalledOnce()
    expect(view.emitted('changed')).toHaveLength(1)
  })

  it('does not expose a restore action without a selected item or after the active list becomes empty', async () => {
    mocks.list.mockResolvedValue(emptyPage())
    wrapper = mount(AttachmentTrashView)
    await flushPromises()
    expect(wrapper.find('.trash-detail').exists()).toBe(false)
    expect(mocks.restore).not.toHaveBeenCalled()
  })
})
