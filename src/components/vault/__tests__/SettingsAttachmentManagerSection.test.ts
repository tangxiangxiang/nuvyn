// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import SettingsAttachmentManagerSection from '../SettingsAttachmentManagerSection.vue'
import type {
  AttachmentCleanupPreview,
  AttachmentPage,
  AttachmentReferencePage,
  ManagedAttachment,
} from '../../../../shared/attachmentProtocol'

const listAttachments = vi.fn()
const refreshAttachmentIndex = vi.fn()
const refreshAttachmentReferences = vi.fn()
const queryAttachmentReferences = vi.fn()
const previewAttachmentCleanup = vi.fn()
const listAttachmentAudit = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
const wrappers: VueWrapper[] = []

vi.mock('../../../lib/attachments-api', () => ({
  listAttachments: (...args: unknown[]) => listAttachments(...args),
  refreshAttachmentIndex: (...args: unknown[]) => refreshAttachmentIndex(...args),
  refreshAttachmentReferences: (...args: unknown[]) => refreshAttachmentReferences(...args),
  queryAttachmentReferences: (...args: unknown[]) => queryAttachmentReferences(...args),
  previewAttachmentCleanup: (...args: unknown[]) => previewAttachmentCleanup(...args),
  listAttachmentAudit: (...args: unknown[]) => listAttachmentAudit(...args),
  listAttachmentTrash: vi.fn().mockResolvedValue({ items: [], total: 0, knownBytes: 0, offset: 0, limit: 30 }),
  quarantineAttachment: vi.fn(),
  restoreAttachment: vi.fn(),
}))

vi.mock('../AttachmentImagePreview.vue', () => ({
  default: { props: ['item', 'compact'], template: '<div class="attachment-image-preview" />' },
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

function referencePage(references: AttachmentReferencePage['references'] = []): AttachmentReferencePage {
  return {
    resource: { kind: 'vault-file', path: 'inbox/assets/diagram.png' },
    references,
    referenceCount: references.length,
    ownerCount: new Set(references.map((reference) => `${reference.owner.kind}:${reference.owner.id}`)).size,
    offset: 0,
    limit: 30,
    nextOffset: null,
    currentFinding: references.length > 0 ? 'in-use' : 'no-current-reference',
    stale: false,
    coverage: {
      currentNotes: 'complete',
      boardReferences: 'complete',
      historicalVersions: 'not-checked',
      unsavedDrafts: 'not-checked',
      protectedDiary: 'restricted',
      boardCheckpoints: 'not-checked',
      externalChanges: 'not-checked',
    },
    snapshotId: 'test-snapshot',
    checkedAt: 100,
  }
}

const riskPreview: AttachmentCleanupPreview = {
  resource: { kind: 'vault-file', path: 'inbox/assets/diagram.png' },
  currentFinding: 'no-current-reference',
  riskLevel: 'review-required',
  referenceCount: 0,
  ownerCount: 0,
  stale: false,
  coverage: referencePage().coverage,
  riskReasons: ['historical-versions-not-checked', 'draft-recovery-not-checked', 'protected-diary-restricted'],
  deletionAllowed: false,
  snapshotId: 'test-snapshot',
  checkedAt: 100,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useI18n().setLocale('zh')
  vi.clearAllMocks()
  listAttachments.mockResolvedValue(page([vaultFile, asset]))
  refreshAttachmentIndex.mockResolvedValue({ indexStatus: { ready: true } })
  refreshAttachmentReferences.mockResolvedValue(referencePage())
  queryAttachmentReferences.mockResolvedValue(referencePage())
  previewAttachmentCleanup.mockResolvedValue(riskPreview)
  listAttachmentAudit.mockResolvedValue([])
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
  it('shows real catalog summary, details, unknown references and only the scoped Note upload control', async () => {
    mountManager()
    await flushPromises()

    expect(document.body.textContent).toContain('附件管理')
    expect(document.body.textContent).toContain('未命名图片 · 12345678')
    expect(document.body.textContent).toContain('引用待确认')
    expect(document.body.querySelectorAll('.attachment-resource-row')).toHaveLength(2)
    expect(Array.from(document.body.querySelectorAll('button')).some((button) => /删除/.test(button.textContent ?? ''))).toBe(false)
    expect(Array.from(document.body.querySelectorAll('button')).some((button) => /上传图片到 Note 附件库/.test(button.textContent ?? ''))).toBe(true)

    const row = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
      .find((button) => button.textContent?.includes('diagram.png'))!
    row.click()
    await flushPromises()
    expect(document.body.textContent).toContain('inbox/assets/diagram.png')
    expect(document.body.textContent).toContain('待确认')
    expect(document.body.querySelector('.attachment-copy')).not.toBeNull()
    expect(document.body.textContent).toContain('引用位置')
  })

  it('shows direct and indirect reference rows, navigates through the host, and keeps risk preflight read-only', async () => {
    const reference = {
      owner: { kind: 'note' as const, id: 'inbox/using-note', title: 'Using note' },
      kind: 'note-image' as const,
      relation: 'indirect' as const,
      sourcePath: 'inbox/shared-note',
      line: 5,
      via: [{ kind: 'include' as const, id: 'inbox/shared-note', title: 'Shared note' }],
      target: { kind: 'vault-file' as const, id: 'inbox/assets/diagram.png' },
      navigable: true,
    }
    queryAttachmentReferences.mockResolvedValueOnce(referencePage([reference]))
    const wrapper = mountManager()
    await flushPromises()
    const row = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
      .find((button) => button.textContent?.includes('diagram.png'))!
    row.click()
    await flushPromises()

    expect(document.body.textContent).toContain('Using note')
    expect(document.body.textContent).toContain('经由 Shared note')
    const referenceButton = document.body.querySelector<HTMLButtonElement>('.attachment-reference-row')!
    referenceButton.click()
    expect(wrapper.emitted('navigateReference')?.[0]).toEqual([reference, 'owner'])
    const sourceButton = wrapper.get('.attachment-reference-source')
    expect(sourceButton.text()).toContain('查看引用源：Shared note')
    await sourceButton.trigger('click')
    expect(wrapper.emitted('navigateReference')?.[1]).toEqual([reference, 'source'])

    await wrapper.get('.attachment-risk-button').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('此预检仅供参考')
    expect(previewAttachmentCleanup).toHaveBeenCalledTimes(1)
    expect(Array.from(document.body.querySelectorAll('button')).some((button) => /删除|Delete/.test(button.textContent ?? ''))).toBe(false)
  })

  it('keeps last successful reference rows visible and marks them stale when refresh fails, then clears stale state after retry', async () => {
    const reference = {
      owner: { kind: 'note' as const, id: 'inbox/using-note', title: 'Using note' },
      kind: 'note-image' as const,
      relation: 'direct' as const,
      sourcePath: 'inbox/using-note',
      target: { kind: 'vault-file' as const, id: 'inbox/assets/diagram.png' },
      navigable: true,
    }
    queryAttachmentReferences.mockResolvedValue(referencePage([reference]))
    const wrapper = mountManager()
    await flushPromises()
    const resourceRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
      .find((button) => button.textContent?.includes('diagram.png'))!
    resourceRow.click()
    await flushPromises()
    expect(wrapper.findAll('.attachment-reference-row')).toHaveLength(1)

    refreshAttachmentReferences.mockRejectedValueOnce(new Error('reference scan offline'))
    await wrapper.get('.attachment-refresh').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.attachment-reference-row')).toHaveLength(1)
    expect(wrapper.find('.attachment-reference-stale').text()).toContain('上次成功分析')
    expect(wrapper.get('.attachment-request-message[role="alert"]').text()).toContain('引用索引刷新失败')

    refreshAttachmentReferences.mockResolvedValueOnce(referencePage())
    await wrapper.get('.attachment-request-message[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.attachment-reference-stale').exists()).toBe(false)
    expect(wrapper.find('.attachment-request-message[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('.attachment-reference-row')).toHaveLength(1)
  })

  it('keeps a Note owner as the primary target for Note-to-Board asset relationships', async () => {
    queryAttachmentReferences.mockResolvedValueOnce(referencePage([{
      owner: { kind: 'note', id: 'inbox/using-note', title: 'Using note' },
      kind: 'board-embed',
      relation: 'indirect',
      sourcePath: 'inbox/using-note.md',
      via: [{ kind: 'board', id: 'board-id', title: 'Architecture Board' }],
      target: { kind: 'vault-file', id: 'inbox/assets/diagram.png' },
      navigable: true,
    }]))
    const wrapper = mountManager()
    await flushPromises()
    const resourceRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
      .find((button) => button.textContent?.includes('diagram.png'))!
    resourceRow.click()
    await flushPromises()

    expect(wrapper.findAll('.attachment-reference-row')).toHaveLength(1)
    expect(wrapper.find('.attachment-reference-source').exists()).toBe(false)
    await wrapper.get('.attachment-reference-row').trigger('click')
    expect(wrapper.emitted('navigateReference')?.[0]).toEqual([expect.objectContaining({ owner: expect.objectContaining({ id: 'inbox/using-note' }) }), 'owner'])
  })

  it('hides source navigation unless the source is confirmed in the navigable dependency chain', async () => {
    queryAttachmentReferences.mockResolvedValueOnce(referencePage([{
      owner: { kind: 'note', id: 'inbox/using-note', title: 'Using note' },
      kind: 'note-image',
      relation: 'indirect',
      sourcePath: 'inbox/unconfirmed-source',
      target: { kind: 'vault-file', id: 'inbox/assets/diagram.png' },
      navigable: true,
    }]))
    const wrapper = mountManager()
    await flushPromises()
    const resourceRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
      .find((button) => button.textContent?.includes('diagram.png'))!
    resourceRow.click()
    await flushPromises()

    expect(wrapper.find('.attachment-reference-row').exists()).toBe(true)
    expect(wrapper.find('.attachment-reference-source').exists()).toBe(false)
  })

  it('discards a late reference response after selection changes', async () => {
    const late = deferred<AttachmentReferencePage>()
    queryAttachmentReferences.mockImplementationOnce(() => late.promise)
    const wrapper = mountManager()
    await flushPromises()
    const rows = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.attachment-resource-row'))
    rows[0]?.click()
    await flushPromises()
    rows[1]?.click()
    await flushPromises()

    late.resolve(referencePage([{
      owner: { kind: 'note', id: 'inbox/stale', title: 'Stale reference' },
      kind: 'note-image',
      relation: 'direct',
      sourcePath: 'inbox/stale',
      target: { kind: 'vault-file', id: 'inbox/assets/diagram.png' },
      navigable: true,
    }]))
    await flushPromises()
    expect(wrapper.text()).not.toContain('Stale reference')
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
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取附件目录')
    expect(Array.from(document.body.querySelectorAll('button')).some((button) => button.textContent?.trim() === '重试')).toBe(true)
  })

  it('keeps the last successful list explicit when a changed query fails and retries current filters', async () => {
    const wrapper = mountManager()
    await flushPromises()
    listAttachments.mockRejectedValueOnce(new Error('offline'))

    await wrapper.get('.n-input input').setValue('missing-resource')
    await new Promise((resolve) => setTimeout(resolve, 220))
    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('加载失败，当前显示的是上一次成功获取的结果')
    expect(wrapper.findAll('.attachment-resource-row')).toHaveLength(2)
    expect(listAttachments).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'missing-resource', offset: 0, limit: 30 }))

    listAttachments.mockResolvedValueOnce(page([vaultFile]))
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('.attachment-resource-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('diagram.png')
  })

  it('reports an explicit index refresh failure without clearing the current results', async () => {
    const wrapper = mountManager()
    await flushPromises()
    refreshAttachmentIndex.mockRejectedValueOnce(new Error('offline'))

    await wrapper.get('.attachment-refresh').trigger('click')
    await flushPromises()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('目录刷新失败')
    expect(alert.text()).toContain('重试')
    expect(wrapper.findAll('.attachment-resource-row')).toHaveLength(2)
    expect(listAttachments).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a refreshed catalog from a failed follow-up list query', async () => {
    const wrapper = mountManager()
    await flushPromises()
    refreshAttachmentIndex.mockResolvedValueOnce({ indexStatus: { ready: true } })
    listAttachments.mockRejectedValueOnce(new Error('list endpoint offline'))

    await wrapper.get('.attachment-refresh').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('目录已刷新，但当前列表加载失败')
    expect(wrapper.findAll('.attachment-resource-row')).toHaveLength(2)
    expect(refreshAttachmentIndex).toHaveBeenCalledTimes(1)
  })

  it('does not present a previous empty result as a match decision for new filters', async () => {
    listAttachments.mockResolvedValueOnce(page([]))
    const wrapper = mountManager()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有可管理的附件')
    const nextQuery = deferred<AttachmentPage>()
    listAttachments.mockImplementationOnce(() => nextQuery.promise)

    await wrapper.get('.n-input input').setValue('new-filter')
    await flushPromises()
    expect(wrapper.text()).toContain('正在加载符合当前条件的结果')
    expect(wrapper.text()).not.toContain('没有符合当前搜索或筛选条件的资源')

    await new Promise((resolve) => setTimeout(resolve, 220))
    nextQuery.reject(new Error('offline'))
    await flushPromises()
    expect(wrapper.text()).toContain('加载失败，当前显示的是上一次成功获取的结果')
    expect(wrapper.text()).not.toContain('没有符合当前搜索或筛选条件的资源')
  })

  it('does not let an older successful query replace the newest result', async () => {
    const wrapper = mountManager()
    await flushPromises()
    const older = deferred<AttachmentPage>()
    listAttachments.mockImplementationOnce(() => older.promise)

    await wrapper.get('.n-input input').setValue('older')
    await new Promise((resolve) => setTimeout(resolve, 220))
    await flushPromises()
    await wrapper.get('.n-input input').setValue('newer')
    await new Promise((resolve) => setTimeout(resolve, 220))
    await flushPromises()
    expect(listAttachments).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'newer' }))

    older.resolve(page([asset]))
    await flushPromises()
    expect(wrapper.findAll('.attachment-resource-row')).toHaveLength(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.attachment-request-message[role="status"]').exists()).toBe(false)
  })

  it('does not let an older failed query override the newest successful state', async () => {
    const wrapper = mountManager()
    await flushPromises()
    const older = deferred<AttachmentPage>()
    listAttachments.mockImplementationOnce(() => older.promise)

    await wrapper.get('.n-input input').setValue('older')
    await new Promise((resolve) => setTimeout(resolve, 220))
    await flushPromises()
    await wrapper.get('.n-input input').setValue('newer')
    await new Promise((resolve) => setTimeout(resolve, 220))
    await flushPromises()

    older.reject(new Error('stale failure'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('.attachment-resource-row')).toHaveLength(2)
  })
})
