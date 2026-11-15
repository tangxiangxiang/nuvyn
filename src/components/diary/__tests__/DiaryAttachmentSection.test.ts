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
const pdf: DiaryAttachment = {
  ...staged,
  id: '7be4f457-e73f-4e7c-8ea2-85ce5b17c7f4',
  name: 'memory.pdf',
  mimeType: 'application/pdf',
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

    const imageCard = wrapper.get(`[data-testid="diary-attachment-${staged.id}"]`)
    expect(imageCard.find('.diary-attachment-meta').exists()).toBe(false)
    expect(imageCard.text()).not.toContain('memory.png')
    expect(imageCard.get('button.diary-attachment-image').attributes('aria-label')).toBe('预览 memory.png')
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

  it('uses the same accessible native remove control for image and PDF only in edit mode', async () => {
    const wrapper = mount(DiaryAttachmentSection, {
      props: { date: staged.date, attachments: [staged, pdf], mode: 'edit' },
      global: {
        stubs: {
          NButton: { template: '<button><slot /></button>' },
          NModal: { template: '<div><slot /></div>' },
          NSpin: { template: '<span />' },
        },
      },
    })
    const removeButtons = wrapper.findAll('button.diary-attachment-remove')
    expect(removeButtons).toHaveLength(2)
    expect(removeButtons.map(button => button.attributes('type'))).toEqual(['button', 'button'])
    expect(removeButtons.map(button => button.attributes('aria-label'))).toEqual([
      '移除 memory.png',
      '移除 memory.pdf',
    ])
    expect(wrapper.get(`[data-testid="diary-attachment-${staged.id}"]`).find('.diary-attachment-meta').exists()).toBe(false)
    const pdfMeta = wrapper.get(`[data-testid="diary-attachment-${pdf.id}"] .diary-attachment-meta`)
    expect(pdfMeta.text()).toBe('memory.pdf')
    expect(pdfMeta.find('small').exists()).toBe(false)

    await removeButtons[0]!.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([[staged.id]])
    expect(wrapper.find('.diary-attachment-preview').exists()).toBe(false)

    await wrapper.setProps({ disabled: true })
    expect((wrapper.get('button.diary-attachment-remove').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('button.diary-attachment-remove').trigger('click')
    expect(wrapper.emitted('remove')).toEqual([[staged.id]])

    await wrapper.setProps({ mode: 'read', disabled: false })
    expect(wrapper.find('button.diary-attachment-remove').exists()).toBe(false)
    expect(wrapper.get(`[data-testid="diary-attachment-${pdf.id}"] .diary-attachment-meta`).text()).toBe('memory.pdf')
    wrapper.unmount()
  })
})
