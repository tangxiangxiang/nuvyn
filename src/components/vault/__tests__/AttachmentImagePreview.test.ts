// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchPreview = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/attachmentPreview', () => ({ fetchAttachmentPreview: fetchPreview }))

import AttachmentImagePreview from '../AttachmentImagePreview.vue'
import type { ManagedAttachment } from '../../../../shared/attachmentProtocol'

const UUID_A = '550e8400-e29b-41d4-a716-446655440000'
const UUID_B = '660e8400-e29b-41d4-a716-446655440000'

function image(id: string): ManagedAttachment {
  return {
    key: { kind: 'asset', id },
    source: 'board-asset',
    type: 'image',
    displayName: id,
    mimeType: 'image/png',
    byteSize: 8,
    createdAt: null,
    modifiedAt: null,
    referenceStatus: 'unknown',
  }
}

describe('AttachmentImagePreview', () => {
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const createObjectURL = vi.fn(() => `blob:preview-${createObjectURL.mock.calls.length}`)
  const revokeObjectURL = vi.fn()

  afterEach(() => {
    fetchPreview.mockReset()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke })
  })

  it('aborts stale reads and revokes the current object URL on unmount', async () => {
    let resolveFirst!: (blob: Blob) => void
    let firstSignal: AbortSignal | undefined
    fetchPreview
      .mockImplementationOnce((_item: ManagedAttachment, signal: AbortSignal) => {
        firstSignal = signal
        return new Promise<Blob>((resolve) => { resolveFirst = resolve })
      })
      .mockResolvedValueOnce(new Blob(['new image'], { type: 'image/png' }))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    const wrapper = mount(AttachmentImagePreview, { props: { item: image(UUID_A) } })
    await wrapper.setProps({ item: image(UUID_B) })
    await flushPromises()

    expect(firstSignal?.aborted).toBe(true)
    expect(wrapper.get('img').attributes('src')).toBe('blob:preview-1')
    resolveFirst(new Blob(['stale image'], { type: 'image/png' }))
    await flushPromises()
    expect(createObjectURL).toHaveBeenCalledOnce()

    wrapper.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('shows a retry action after a failed preview read', async () => {
    fetchPreview.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Blob(['ok'], { type: 'image/png' }))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const wrapper = mount(AttachmentImagePreview, { props: { item: image(UUID_A) } })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toMatch(/Retry|重试/u)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows a local retry state and revokes the URL when the browser cannot decode an image', async () => {
    fetchPreview.mockResolvedValue(new Blob(['not an image'], { type: 'image/png' }))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const wrapper = mount(AttachmentImagePreview, { props: { item: image(UUID_A) } })
    await flushPromises()

    await wrapper.get('img').trigger('error')
    expect(wrapper.get('[role="status"]').text()).toMatch(/Preview failed|预览失败/u)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    wrapper.unmount()
  })
})
