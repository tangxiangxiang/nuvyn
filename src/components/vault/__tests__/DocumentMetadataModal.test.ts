// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentMetadataModal from '../DocumentMetadataModal.vue'
import { useI18n } from '../../../composables/useI18n'

const getPost = vi.fn()
const updateDocumentMetadata = vi.fn()
const suggestSummary = vi.fn()

vi.mock('../../../lib/api', () => ({
  getPost: (...args: unknown[]) => getPost(...args),
  updateDocumentMetadata: (...args: unknown[]) => updateDocumentMetadata(...args),
}))

vi.mock('../../../lib/ai-api', () => ({
  suggestSummary: (...args: unknown[]) => suggestSummary(...args),
}))

vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

const metadata = {
  id: 'doc-1', path: 'inbox/note', title: 'Note', summary: 'Summary',
  tags: ['rag', 'notes'], createdAt: 1, updatedAt: 2,
}

beforeEach(() => {
  useI18n().setLocale('zh')
  getPost.mockReset().mockResolvedValue({ metadata, frontmatter: {} })
  updateDocumentMetadata.mockReset().mockResolvedValue({ ...metadata, title: 'Updated' })
  suggestSummary.mockReset().mockResolvedValue({ summary: 'AI 生成的摘要' })
})
afterEach(() => {
  useI18n().setLocale('zh')
  document.body.innerHTML = ''
})

describe('DocumentMetadataModal', () => {
  it('loads metadata and saves normalized lists', async () => {
    const wrapper = mount(DocumentMetadataModal, {
      props: { open: true, path: 'inbox/note' },
      attachTo: document.body,
    })
    await flushPromises()
    const inputs = document.body.querySelectorAll<HTMLInputElement>('.document-metadata-field input')
    expect(inputs[0].value).toBe('Note')
    expect(document.body.textContent).toContain('文档属性')
    expect(document.body.textContent).toContain('doc-1')
    expect(document.body.textContent).toContain('inbox')
    const tagInput = document.body.querySelector<HTMLInputElement>('input[placeholder="rag, notes"]')!
    tagInput.value = 'rag, RAG, new'
    tagInput.dispatchEvent(new Event('input', { bubbles: true }))
    document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(updateDocumentMetadata).toHaveBeenCalledWith('inbox/note', expect.objectContaining({
      tags: ['rag', 'new'],
    }))
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({ title: 'Updated' })
    wrapper.unmount()
  })

  it('closes on Escape', async () => {
    const wrapper = mount(DocumentMetadataModal, {
      props: { open: true, path: 'inbox/note' },
      attachTo: document.body,
    })
    await flushPromises()
    document.body.querySelector('.document-metadata-backdrop')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('generates a summary from the shared metadata form', async () => {
    const wrapper = mount(DocumentMetadataModal, {
      props: { open: true, path: 'inbox/note' },
      attachTo: document.body,
    })
    await flushPromises()

    await (document.body.querySelector('.metadata-generate-summary') as HTMLButtonElement).click()
    await flushPromises()

    expect(suggestSummary).toHaveBeenCalledWith(
      { path: 'inbox/note', language: 'zh' },
      expect.any(AbortSignal),
    )
    expect((document.body.querySelector('textarea') as HTMLTextAreaElement).value).toBe('AI 生成的摘要')
    wrapper.unmount()
  })
})
