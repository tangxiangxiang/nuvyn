// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { DiaryAttachment } from '../../../../shared/diaryAttachments'
import { diaryAttachmentsApi } from '../../../lib/diary-attachments-api'
import DiaryAttachmentSection from '../DiaryAttachmentSection.vue'

const staged: DiaryAttachment = {
  id: '92f3bb2b-2ded-43f3-8db2-dc77954bc918',
  date: '2026-11-15',
  name: 'memory.png',
  mimeType: 'image/png',
  size: 5,
  createdAt: 1,
  order: 0,
}
let originalCreateObjectURL: PropertyDescriptor | undefined
let originalRevokeObjectURL: PropertyDescriptor | undefined

beforeEach(() => {
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:protected-content' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
})

afterEach(() => {
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
})

describe('DiaryAttachmentSection staged image previews', () => {
  it('uses the in-memory preview while staged and switches to protected content after save', async () => {
    const content = vi.spyOn(diaryAttachmentsApi, 'content').mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const wrapper = mount(DiaryAttachmentSection, {
      attachTo: document.body,
      props: {
        date: staged.date,
        attachments: [{ ...staged, pending: true, localPreviewUrl: 'blob:staged-preview' }],
        mode: 'edit',
      },
      global: {
        stubs: {
          NButton: { template: '<button><slot /></button>' },
          NModal: { template: '<div><slot /></div>' },
          NSpin: { template: '<span />' },
        },
      },
    })
    await nextTick()

    expect(wrapper.get('img').attributes('src')).toBe('blob:staged-preview')
    expect(content).not.toHaveBeenCalled()

    await wrapper.setProps({ attachments: [{ ...staged }] })
    await nextTick()
    await wrapper.get('button[aria-label="预览 memory.png"]').trigger('click')
    await flushPromises()

    expect(content).toHaveBeenCalledWith(staged, expect.any(AbortSignal))
    expect(wrapper.get('img').attributes('src')).not.toBe('blob:staged-preview')
    expect(document.body.querySelector('.diary-attachment-preview')).not.toBeNull()
    wrapper.unmount()
  })
})
