// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentMetadataForm from '../DocumentMetadataForm.vue'
import { draftsByDocumentId, metadataDrafts } from '../metadataDraftStore'
import { useI18n } from '../../../composables/useI18n'

const getPost = vi.fn()
const updateDocumentMetadata = vi.fn()
const suggestSummary = vi.fn()
const toastErrors = vi.fn()
const toastSuccesses = vi.fn()

vi.mock('../../../lib/api', () => ({
  getPost: (...args: unknown[]) => getPost(...args),
  updateDocumentMetadata: (...args: unknown[]) => updateDocumentMetadata(...args),
}))
vi.mock('../../../lib/ai-api', () => ({
  suggestSummary: (...args: unknown[]) => suggestSummary(...args),
}))
vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccesses, error: toastErrors, info: vi.fn() }),
}))

const post = (path: string, id: string, title: string) => ({
  path,
  raw: `# ${title}`,
  content: `# ${title}`,
  frontmatter: {},
  metadata: { id, path, title, summary: `${title} summary`, tags: ['Rag'], createdAt: 1, updatedAt: 2 },
  size: 1,
  mtime: 2,
})

beforeEach(() => {
  draftsByDocumentId.clear()
  useI18n().setLocale('en')
  toastErrors.mockReset()
  toastSuccesses.mockReset()
  getPost.mockReset().mockImplementation((path: string) => Promise.resolve(post(path, `id-${path}`, path)))
  updateDocumentMetadata.mockReset().mockImplementation(async (path: string, input: any) => ({
    ...post(path, `id-${path}`, path).metadata,
    ...input,
    title: input.title ?? path,
    summary: input.summary ?? `${path} summary`,
    tags: input.tags ?? ['Rag'],
    updatedAt: 99,
  }))
  suggestSummary.mockReset().mockResolvedValue({ summary: 'AI summary' })
})

describe('DocumentMetadataForm', () => {
  it('loads normally and keeps save disabled until a normalized change is made', async () => {
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a', showCancel: false } })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('a')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('input').setValue('  New title  ')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
  })

  it('ignores an older response and its finally while a newer path is loading', async () => {
    let resolveA!: (value: any) => void
    let resolveB!: (value: any) => void
    getPost.mockReset()
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await wrapper.setProps({ path: 'b' })
    resolveB(post('b', 'id-b', 'B'))
    await flushPromises()
    resolveA(post('a', 'id-a', 'A'))
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('B')
    expect(wrapper.get('[aria-busy]').attributes('aria-busy')).toBe('false')
  })

  it('clears old fields on failure, blocks saving, and retries inline', async () => {
    getPost.mockReset().mockResolvedValueOnce(post('a', 'id-a', 'A')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(post('b', 'id-b', 'B'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.setProps({ path: 'b' })
    await flushPromises()
    expect(wrapper.text()).toContain('Failed to load')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false)
    await wrapper.get('.document-metadata-error button').trigger('click')
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('B')
  })

  it('preserves separate dirty drafts by document id across tab-like path switches', async () => {
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('A draft')
    await wrapper.setProps({ enabled: false })
    await wrapper.setProps({ path: 'b', enabled: true })
    await flushPromises()
    await wrapper.get('input').setValue('B draft')
    await wrapper.setProps({ enabled: false })
    await wrapper.setProps({ path: 'a', enabled: true })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('A draft')
    expect(draftsByDocumentId.get('id:id-b')?.title).toBe('B draft')
  })

  it('resets to the last successful base and saves updated base/updatedAt', async () => {
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('Changed')
    await wrapper.get('.document-metadata-actions button:nth-of-type(2)').trigger('click')
    expect(wrapper.get('input').element.value).toBe('a')
    await wrapper.get('input').setValue('Saved')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateDocumentMetadata).toHaveBeenCalledWith('a', expect.objectContaining({ title: 'Saved' }))
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('sends only the changed metadata field and never replays tags for a title edit', async () => {
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('Saved')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateDocumentMetadata).toHaveBeenCalledWith('a', { title: 'Saved' })
  })

  it('sends the tag version token only with an explicit tag edit', async () => {
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.findAll('input')[1].setValue('Fresh')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(updateDocumentMetadata).toHaveBeenCalledWith('a', {
      tags: ['Fresh'], expectedUpdatedAt: 2,
    })
  })

  it('does not let a save response for A overwrite the newly loaded B form', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('A changed')
    await wrapper.get('form').trigger('submit')
    await wrapper.setProps({ path: 'b' })
    await flushPromises()
    resolveSave({ ...post('a', 'id-a', 'A changed').metadata, title: 'A saved', updatedAt: 100 })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('b')
    expect(draftsByDocumentId.has('id:id-b')).toBe(false)
  })

  it('saves a legacy document without a document id and upgrades its identity', async () => {
    getPost.mockReset().mockResolvedValue({
      path: 'legacy', raw: '# Legacy', content: '# Legacy',
      frontmatter: { title: 'Legacy title', summary: '', tags: [] },
      metadata: undefined, size: 1, mtime: 2,
    })
    updateDocumentMetadata.mockResolvedValue({
      id: 'legacy-id', path: 'legacy', title: 'Updated legacy', summary: '', tags: [],
      createdAt: 1, updatedAt: 99,
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Updated legacy')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(updateDocumentMetadata).toHaveBeenCalledWith('legacy', expect.objectContaining({ title: 'Updated legacy' }))
    expect(wrapper.emitted('saved')).toEqual([[expect.objectContaining({ id: 'legacy-id', updatedAt: 99 })]])
    expect(metadataDrafts.has('path:legacy')).toBe(false)
    expect(metadataDrafts.has('id:legacy-id')).toBe(false)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('restores a dirty legacy draft by path after switching away and back', async () => {
    getPost.mockReset().mockImplementation(async (path: string) => path === 'legacy'
      ? {
          path, raw: '# Legacy', content: '# Legacy',
          frontmatter: { title: 'Legacy title', summary: '', tags: [] },
          metadata: undefined, size: 1, mtime: 2,
        }
      : post(path, 'id-other', 'Other'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Legacy draft')
    await wrapper.setProps({ enabled: false })
    await wrapper.setProps({ path: 'other', enabled: true })
    await flushPromises()
    await wrapper.setProps({ enabled: false })
    await wrapper.setProps({ path: 'legacy', enabled: true })
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('Legacy draft')
    expect(metadataDrafts.get('path:legacy')?.documentId).toBeNull()
  })

  it('keeps newer legacy edits when the first save returns a document id', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    getPost.mockReset().mockResolvedValue({
      path: 'legacy', raw: '# Legacy', content: '# Legacy',
      frontmatter: { title: 'Legacy title', summary: '', tags: [] },
      metadata: undefined, size: 1, mtime: 2,
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Revision one')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('Revision two')
    resolveSave({ id: 'legacy-id', path: 'legacy', title: 'Revision one', summary: '', tags: [], createdAt: 1, updatedAt: 88 })
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('Revision two')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(metadataDrafts.get('id:legacy-id')).toEqual(expect.objectContaining({
      title: 'Revision two',
      base: expect.objectContaining({ title: 'Revision one', updatedAt: 88 }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('preserves an edit back to the old base while the save is in flight', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('a')
    resolveSave({ ...post('a', 'id-a', 'B').metadata, title: 'B', updatedAt: 101 })
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('a')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'a',
      base: expect.objectContaining({ title: 'B' }),
      dirty: true,
      revision: expect.any(Number),
    }))
    expect(metadataDrafts.get('id:id-a')?.revision).toBeGreaterThan(1)
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('preserves an edit back to the old base after switching documents', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    const savingRevision = 1
    await wrapper.get('input').setValue('a')
    await wrapper.setProps({ path: 'b' })
    await flushPromises()

    const savedA = { ...post('a', 'id-a', 'B').metadata, title: 'B', updatedAt: 101 }
    resolveSave(savedA)
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('b')
    expect(wrapper.emitted('saved')).toEqual([[savedA]])
    expect(metadataDrafts.has('path:a')).toBe(false)
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'a',
      base: expect.objectContaining({ title: 'B' }),
      dirty: true,
    }))
    expect(metadataDrafts.get('id:id-a')?.revision).toBeGreaterThan(savingRevision)
  })

  it('removes a newer draft when its fields end at the saved base', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('C')
    await wrapper.get('input').setValue('B')
    resolveSave({ ...post('a', 'id-a', 'a').metadata, title: 'B', updatedAt: 102 })
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('B')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(metadataDrafts.has('id:id-a')).toBe(false)
  })

  it('migrates a legacy edit back to its old base when the first save returns an id', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    getPost.mockReset().mockResolvedValue({
      path: 'legacy', raw: '# Legacy', content: '# Legacy',
      frontmatter: { title: 'Legacy title', summary: '', tags: [] },
      metadata: undefined, size: 1, mtime: 2,
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Saved title')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('Legacy title')
    resolveSave({
      id: 'legacy-id', path: 'legacy', title: 'Saved title', summary: '', tags: [],
      createdAt: 1, updatedAt: 88,
    })
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('Legacy title')
    expect(metadataDrafts.has('path:legacy')).toBe(false)
    expect(metadataDrafts.get('id:legacy-id')).toEqual(expect.objectContaining({
      title: 'Legacy title',
      base: expect.objectContaining({ title: 'Saved title' }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('preserves a legacy edit back to the old base after switching documents', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    getPost.mockReset().mockImplementation(async (path: string) => path === 'legacy'
      ? {
          path, raw: '# Legacy', content: '# Legacy',
          frontmatter: { title: 'Legacy title', summary: '', tags: [] },
          metadata: undefined, size: 1, mtime: 2,
        }
      : post(path, 'id-other', 'Other'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Saved title')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('Legacy title')
    await wrapper.setProps({ path: 'other' })
    await flushPromises()

    const savedLegacy = {
      id: 'legacy-id', path: 'legacy', title: 'Saved title', summary: '', tags: [],
      createdAt: 1, updatedAt: 88,
    }
    resolveSave(savedLegacy)
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('Other')
    expect(wrapper.emitted('saved')).toEqual([[savedLegacy]])
    expect(metadataDrafts.has('path:legacy')).toBe(false)
    expect(metadataDrafts.get('id:legacy-id')).toEqual(expect.objectContaining({
      title: 'Legacy title',
      base: expect.objectContaining({ title: 'Saved title' }),
      dirty: true,
    }))
  })

  it('reconciles a lost save response after the server has saved while staying on the document', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    let readsA = 0
    getPost.mockReset().mockImplementation(async (path: string) => {
      if (path === 'a') {
        readsA++
        return readsA === 1 ? post('a', 'id-a', 'a') : { ...post('a', 'id-a', 'a'), metadata: { ...post('a', 'id-a', 'a').metadata, title: 'B' } }
      }
      return post(path, `id-${path}`, path)
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('a')
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('a')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'a',
      base: expect.objectContaining({ title: 'B' }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(toastErrors).not.toHaveBeenCalled()
  })

  it('reconciles a lost save response after switching to another document', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    let readsA = 0
    getPost.mockReset().mockImplementation(async (path: string) => {
      if (path === 'a') {
        readsA++
        return readsA === 1 ? post('a', 'id-a', 'a') : { ...post('a', 'id-a', 'a'), metadata: { ...post('a', 'id-a', 'a').metadata, title: 'B' } }
      }
      return post(path, `id-${path}`, path)
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('a')
    await wrapper.setProps({ path: 'b' })
    await flushPromises()
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('b')
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'a',
      base: expect.objectContaining({ title: 'B' }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(toastErrors).not.toHaveBeenCalled()
  })

  it('clears the temporary clean snapshot when reread proves the save did not land', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    let readsA = 0
    getPost.mockReset().mockImplementation(async (path: string) => {
      if (path === 'a') {
        readsA++
        return post('a', 'id-a', 'a')
      }
      return post(path, `id-${path}`, path)
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('a')
    rejectSave(new Error('request failed'))
    await flushPromises()

    expect(readsA).toBe(2)
    expect(wrapper.get('input').element.value).toBe('a')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(metadataDrafts.has('id:id-a')).toBe(false)
    expect(toastErrors).toHaveBeenCalledWith(expect.stringContaining('Failed to save document properties'))
  })

  it('preserves the save payload when reread confirms the save did not land', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    getPost.mockReset().mockResolvedValue(post('a', 'id-a', 'a'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    rejectSave(new Error('request failed'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('B')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'B',
      base: expect.objectContaining({ title: 'a' }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(toastErrors).toHaveBeenCalledWith(expect.stringContaining('Failed to save document properties'))
  })

  it('preserves a failed save payload after switching documents', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    getPost.mockReset().mockImplementation(async (path: string) => post(path, `id-${path}`, path))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.setProps({ path: 'c' })
    await flushPromises()
    rejectSave(new Error('request failed'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('c')
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'B',
      base: expect.objectContaining({ title: 'a' }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('keeps the save payload dirty when both save and reread results are unknown', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    getPost.mockReset()
      .mockResolvedValueOnce(post('a', 'id-a', 'a'))
      .mockRejectedValueOnce(new Error('refresh failed'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('B')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'B',
      base: expect.objectContaining({ title: 'a' }),
      dirty: true,
    }))
    expect(toastErrors).toHaveBeenCalledWith(expect.stringContaining('Could not confirm the save result'))
  })

  it('preserves an unknown save draft after switching documents', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    let readsA = 0
    getPost.mockReset().mockImplementation(async (path: string) => {
      if (path === 'a') {
        readsA++
        if (readsA === 1) return post('a', 'id-a', 'a')
        throw new Error('refresh failed')
      }
      return post('c', 'id-c', 'c')
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.setProps({ path: 'c' })
    await flushPromises()
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('c')
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'B',
      base: expect.objectContaining({ title: 'a' }),
      dirty: true,
    }))
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('preserves a failed legacy save under its path identity', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    const legacyPost = {
      path: 'legacy', raw: '# Legacy', content: '# Legacy',
      frontmatter: { title: 'Legacy title', summary: '', tags: [] },
      metadata: undefined, size: 1, mtime: 2,
    }
    getPost.mockReset().mockResolvedValue(legacyPost)
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Saved title')
    await wrapper.get('form').trigger('submit')
    rejectSave(new Error('request failed'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('Saved title')
    expect(metadataDrafts.get('path:legacy')).toEqual(expect.objectContaining({
      title: 'Saved title',
      base: expect.objectContaining({ title: 'Legacy title' }),
      dirty: true,
    }))
  })

  it('preserves an unknown legacy save under its path identity', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    const legacyPost = {
      path: 'legacy', raw: '# Legacy', content: '# Legacy',
      frontmatter: { title: 'Legacy title', summary: '', tags: [] },
      metadata: undefined, size: 1, mtime: 2,
    }
    getPost.mockReset().mockResolvedValueOnce(legacyPost).mockRejectedValueOnce(new Error('refresh failed'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Saved title')
    await wrapper.get('form').trigger('submit')
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('Saved title')
    expect(metadataDrafts.get('path:legacy')).toEqual(expect.objectContaining({
      title: 'Saved title',
      base: expect.objectContaining({ title: 'Legacy title' }),
      dirty: true,
    }))
    expect(metadataDrafts.has('id:legacy-id')).toBe(false)
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('keeps the latest fields dirty when the save result and reread are both unknown', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    getPost.mockReset()
      .mockResolvedValueOnce(post('a', 'id-a', 'a'))
      .mockRejectedValueOnce(new Error('refresh failed'))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('a')
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('a')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(metadataDrafts.get('id:id-a')).toEqual(expect.objectContaining({
      title: 'a',
      base: expect.objectContaining({ title: 'B' }),
      dirty: true,
    }))
    expect(toastErrors).toHaveBeenCalledWith(expect.stringContaining('Could not confirm the save result'))
  })

  it('confirms a lost save without keeping a draft when reread matches the payload', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    getPost.mockReset()
      .mockResolvedValueOnce(post('a', 'id-a', 'a'))
      .mockResolvedValueOnce({
        ...post('a', 'id-a', 'a'),
        metadata: { ...post('a', 'id-a', 'a').metadata, title: 'B' },
      })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('B')
    await wrapper.get('form').trigger('submit')
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('B')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(metadataDrafts.has('id:id-a')).toBe(false)
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(toastSuccesses).toHaveBeenCalledTimes(1)
    expect(toastErrors).not.toHaveBeenCalled()
  })

  it('reconciles a lost legacy save response after switching documents', async () => {
    let rejectSave!: (cause: unknown) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject }))
    let readsLegacy = 0
    getPost.mockReset().mockImplementation(async (path: string) => {
      if (path === 'legacy') {
        readsLegacy++
        if (readsLegacy === 1) {
          return {
            path, raw: '# Legacy', content: '# Legacy',
            frontmatter: { title: 'Legacy title', summary: '', tags: [] },
            metadata: undefined, size: 1, mtime: 2,
          }
        }
        return {
          ...post('legacy', 'legacy-id', 'Legacy title'),
          metadata: { ...post('legacy', 'legacy-id', 'Legacy title').metadata, title: 'Saved title', summary: '', tags: [] },
        }
      }
      return post(path, `id-${path}`, path)
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'legacy' } })
    await flushPromises()
    await wrapper.get('input').setValue('Saved title')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('input').setValue('Legacy title')
    await wrapper.setProps({ path: 'other' })
    await flushPromises()
    rejectSave(new Error('response lost'))
    await flushPromises()

    expect(wrapper.get('input').element.value).toBe('other')
    expect(metadataDrafts.has('path:legacy')).toBe(false)
    expect(metadataDrafts.get('id:legacy-id')).toEqual(expect.objectContaining({
      title: 'Legacy title',
      base: expect.objectContaining({ title: 'Saved title' }),
      dirty: true,
    }))
  })

  it('emits A saved globally when the form has switched to B', async () => {
    let resolveSave!: (value: any) => void
    updateDocumentMetadata.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('A changed')
    await wrapper.get('form').trigger('submit')
    await wrapper.setProps({ path: 'b' })
    await flushPromises()
    const savedA = { ...post('a', 'id-a', 'A changed').metadata, title: 'A saved', updatedAt: 100 }
    resolveSave(savedA)
    await flushPromises()

    expect(wrapper.emitted('saved')).toEqual([[savedA]])
    expect(wrapper.get('input').element.value).toBe('b')
  })

  it('fails closed on a mismatched save identity and keeps the draft', async () => {
    updateDocumentMetadata.mockResolvedValueOnce({
      ...post('a', 'foreign-id', 'Foreign').metadata,
      path: 'other-path',
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('input').setValue('A changed')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(metadataDrafts.get('id:id-a')?.title).toBe('A changed')
  })

  it('uses the live summary source and ignores a response after the user edits the field', async () => {
    let resolveSummary!: (value: { summary: string }) => void
    suggestSummary.mockReturnValueOnce(new Promise((resolve) => { resolveSummary = resolve }))
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a', summarySource: '# live unsaved body' } })
    await flushPromises()
    await wrapper.get('.metadata-generate-summary').trigger('click')
    await wrapper.get('textarea').setValue('User summary')
    resolveSummary({ summary: 'stale AI result' })
    await flushPromises()
    expect(suggestSummary).toHaveBeenCalledWith(
      { path: 'a', language: 'en', content: '# live unsaved body' },
      expect.any(AbortSignal),
    )
    expect(wrapper.get('textarea').element.value).toBe('User summary')
  })

  it('is readonly in history, diff, and recovery contexts, including the save shortcut', async () => {
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a', context: 'history' } })
    await flushPromises()
    expect(wrapper.text()).toContain('historical version')
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.metadata-generate-summary').exists()).toBe(false)
    await wrapper.get('form').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(updateDocumentMetadata).not.toHaveBeenCalled()
  })

  it('aborts summary generation on unmount', async () => {
    let signal!: AbortSignal
    suggestSummary.mockImplementationOnce((_input: unknown, nextSignal: AbortSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    const wrapper = mount(DocumentMetadataForm, { props: { path: 'a' } })
    await flushPromises()
    await wrapper.get('.metadata-generate-summary').trigger('click')
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })
})
