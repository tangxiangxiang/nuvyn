// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import SettingsAttachmentManagerSection from '../SettingsAttachmentManagerSection.vue'
import type { AttachmentPage, ManagedAttachment } from '../../../../shared/attachmentProtocol'

const listAttachments = vi.fn()
const refreshAttachmentIndex = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
const wrappers: VueWrapper[] = []

vi.mock('../../../lib/attachments-api', () => ({
  listAttachments: (...args: unknown[]) => listAttachments(...args),
  refreshAttachmentIndex: (...args: unknown[]) => refreshAttachmentIndex(...args),
}))

vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

function page(items: ManagedAttachment[]): AttachmentPage {
  const sources = {
    'board-asset': { count: 0, knownBytes: 0 },
    'vault-file': { count: 0, knownBytes: 0 },
    'board-material': { count: 0, knownBytes: 0 },
  }
  for (const item of items) {
    sources[item.source].count += 1
    sources[item.source].knownBytes += item.byteSize ?? 0
  }
  return {
    items,
    total: items.length,
    offset: 0,
    limit: 30,
    summary: {
      total: items.length,
      knownBytes: items.reduce((total, item) => total + (item.byteSize ?? 0), 0),
      unknownByteSizeCount: items.filter((item) => item.byteSize === null).length,
      unknownReferenceCount: items.filter((item) => item.referenceStatus === 'unknown').length,
      sources,
      complete: true,
    },
    indexStatus: {
      ready: true,
      refreshing: false,
      complete: true,
      refreshedAt: 100,
      sources: {
        'board-asset': { state: 'ready', itemCount: sources['board-asset'].count },
        'vault-file': { state: 'ready', itemCount: sources['vault-file'].count },
        'board-material': { state: 'ready', itemCount: sources['board-material'].count },
      },
    },
  }
}

const vaultFile: ManagedAttachment = {
  key: { kind: 'vault-file', path: 'inbox/assets/diagram.png' },
  source: 'vault-file',
  type: 'image',
  displayName: 'diagram.png',
  mimeType: 'image/png',
  byteSize: 1234,
  createdAt: null,
  modifiedAt: 200,
  referenceStatus: 'unknown',
}

const asset: ManagedAttachment = {
  key: { kind: 'asset', id: '12345678-1234-4234-8234-123456789abc' },
  source: 'board-asset',
  type: 'image',
  displayName: null,
  mimeType: 'image/png',
  byteSize: 8,
  createdAt: 100,
  modifiedAt: null,
  referenceStatus: 'unknown',
  knownReferenceCount: 0,
}

beforeEach(() => {
  useI18n().setLocale('zh')
  vi.clearAllMocks()
  listAttachments.mockResolvedValue(page([vaultFile, asset]))
  refreshAttachmentIndex.mockResolvedValue({ indexStatus: { ready: true } })
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  useI18n().setLocale('zh')
})

function mountManager() {
  const wrapper = mount(SettingsAttachmentManagerSection, { attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}

describe('SettingsAttachmentManagerSection', () => {
  it('shows real catalog summary, details, unknown references and no mutation controls', async () => {
    mountManager()
    await flushPromises()

    expect(document.body.textContent).toContain('附件管理')
    expect(document.body.textContent).toContain('未命名图片 · 12345678')
    expect(document.body.textContent).toContain('引用待确认')
    expect(document.body.querySelectorAll('.attachment-resource-row')).toHaveLength(2)
    expect(Array.from(document.body.querySelectorAll('button')).some((button) => /删除|上传/.test(button.textContent ?? ''))).toBe(false)

    const row = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
      .find((button) => button.textContent?.includes('diagram.png'))!
    row.click()
    await flushPromises()
    expect(document.body.textContent).toContain('inbox/assets/diagram.png')
    expect(document.body.textContent).toContain('待确认')
    expect(document.body.querySelector('.attachment-copy')).not.toBeNull()
  })

  it('sends the search filter to the server', async () => {
    const wrapper = mountManager()
    await flushPromises()
    const search = wrapper.get('.n-input input')
    await search.setValue('diagram')
    await new Promise((resolve) => setTimeout(resolve, 220))
    await flushPromises()
    expect(listAttachments).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'diagram', offset: 0, limit: 30 }))
  })

  it('distinguishes a truly empty catalog from a request failure', async () => {
    listAttachments.mockResolvedValueOnce(page([]))
    const empty = mountManager()
    await flushPromises()
    expect(document.body.textContent).toContain('还没有可管理的附件')
    empty.unmount()
    wrappers.splice(wrappers.indexOf(empty), 1)
    document.body.innerHTML = ''

    listAttachments.mockRejectedValueOnce(new Error('offline'))
    mountManager()
    await flushPromises()
    expect(document.body.textContent).toContain('暂时无法读取附件目录')
    expect(document.body.textContent).not.toContain('还没有可管理的附件')
  })
})
