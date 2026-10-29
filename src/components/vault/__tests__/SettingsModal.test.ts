// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { NCheckbox, NInputNumber, NSelect } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import SettingsModal from '../SettingsModal.vue'
import TagManagementPanel from '../TagManagementPanel.vue'
import { useEditorPreferences } from '../../../composables/vault/useEditorPreferences'
import { useFileTreePreferences } from '../../../composables/vault/useFileTreePreferences'

const getAiProfiles = vi.fn()
const createAiProfile = vi.fn()
const updateAiProfile = vi.fn()
const activateAiProfile = vi.fn()
const deleteAiProfile = vi.fn()
const testAiProfileConnection = vi.fn()
const getMetadataMigrationStatus = vi.fn()
const getFrontmatterCleanupPreview = vi.fn()
const cleanDocumentFrontmatter = vi.fn()
const restoreDocumentFrontmatter = vi.fn()
const confirm = vi.fn()
const loadActive = vi.fn()
const loadSettings = vi.fn()
const activateFocusTrap = vi.fn()
const deactivateFocusTrap = vi.fn()
const onFocusTrapTab = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
const listManagedTags = vi.fn()
const getUndoAvailability = vi.fn()
const listAttachments = vi.fn()
const refreshAttachmentIndex = vi.fn()

vi.mock('../../../lib/ai-api', () => ({
  getAiProfiles: (...args: unknown[]) => getAiProfiles(...args),
  createAiProfile: (...args: unknown[]) => createAiProfile(...args),
  updateAiProfile: (...args: unknown[]) => updateAiProfile(...args),
  activateAiProfile: (...args: unknown[]) => activateAiProfile(...args),
  deleteAiProfile: (...args: unknown[]) => deleteAiProfile(...args),
  testAiProfileConnection: (...args: unknown[]) => testAiProfileConnection(...args),
}))

vi.mock('../../../lib/api', () => ({
  getMetadataMigrationStatus: (...args: unknown[]) => getMetadataMigrationStatus(...args),
  getFrontmatterCleanupPreview: (...args: unknown[]) => getFrontmatterCleanupPreview(...args),
  cleanDocumentFrontmatter: (...args: unknown[]) => cleanDocumentFrontmatter(...args),
  restoreDocumentFrontmatter: (...args: unknown[]) => restoreDocumentFrontmatter(...args),
}))

vi.mock('../../../lib/tag-management-api', () => ({
  listManagedTags: (...args: unknown[]) => listManagedTags(...args),
  applyTagOperation: vi.fn(),
  assertApplyResultMatchesReviewedPreview: vi.fn(),
  getTagOperationPreviewPage: vi.fn(),
  previewTagOperation: vi.fn(),
  TagManagementApiError: class extends Error {
    readonly code = 'CLIENT_PROTOCOL_ERROR'
  },
}))

vi.mock('../../../lib/tag-undo-api', () => ({
  getUndoAvailability: (...args: unknown[]) => getUndoAvailability(...args),
  applyUndo: vi.fn(),
  getUndoPreviewPage: vi.fn(),
  previewUndo: vi.fn(),
  TagUndoApiError: class extends Error {
    readonly code = 'CLIENT_PROTOCOL_ERROR'
  },
}))

vi.mock('../../../lib/attachments-api', () => ({
  listAttachments: (...args: unknown[]) => listAttachments(...args),
  refreshAttachmentIndex: (...args: unknown[]) => refreshAttachmentIndex(...args),
}))

vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

vi.mock('../../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm, confirmCancellable: (...args: unknown[]) => ({ promise: confirm(...args), cancel: vi.fn() }) }),
}))

vi.mock('../../../composables/useFocusTrap', () => ({
  useFocusTrap: () => ({
    activate: activateFocusTrap,
    deactivate: deactivateFocusTrap,
    onTab: onFocusTrapTab,
  }),
}))

vi.mock('../../../composables/vault/useAiHistory', () => ({
  useAiHistory: () => ({ loadActive, loadSettings }),
}))

vi.mock('../../../composables/vault/context/useVaultContext', () => ({
  useOptionalVaultContext: () => null,
}))

const openAiSettings = () => ({
  id: 'openai-profile', name: 'Agnes AI', createdAt: 1, updatedAt: 1,
  provider: 'openai' as const,
  configured: true,
  source: 'db' as const,
  maskedKey: '••••••••••••••••abcd',
  baseURL: 'https://apihub.agnes-ai.com/v1',
  model: 'agnes-2.5-flash',
})

const anthropicSettings = () => ({
  id: 'anthropic-profile', name: 'MiniMax', createdAt: 2, updatedAt: 2,
  provider: 'anthropic' as const,
  configured: true,
  source: 'db' as const,
  maskedKey: '••••••••wxyz',
  baseURL: '',
  model: 'claude-sonnet-4-6',
})

const migration = {
  summary: {
    total: 3,
    legacy: 0,
    imported: 3,
    verified: 3,
    cleaned: 1,
    failed: 0,
    orphaned: 0,
  },
  cleanedPaths: ['inbox/cleaned'],
}

const wrappers: VueWrapper[] = []

function mountSettings(options: { withTags?: boolean } = {}) {
  const wrapper = mount(SettingsModal, {
    props: { open: true },
    slots: options.withTags ? {
      tags: () => h(TagManagementPanel, {
        selectedTag: null,
        selectionEpoch: 0,
        syncAfterCommit: async () => ({ managedTags: [], selectedTag: null }),
        recoverCommittedOperation: async () => ({ managedTags: [], selectedTag: null }),
      }),
    } : undefined,
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((item) => item.textContent?.trim() === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function fieldControl<T extends HTMLInputElement | HTMLSelectElement>(
  label: string,
  selector: 'input' | 'select',
): T {
  const field = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label'))
    .find((item) => item.querySelector('.settings-field-label')?.textContent?.trim() === label)
  const control = field?.querySelector<T>(selector)
  if (!control) throw new Error(`Field not found: ${label}`)
  return control
}

function inputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  useI18n().setLocale('zh')
  localStorage.clear()
  vi.clearAllMocks()
  getAiProfiles.mockResolvedValue({ profiles: [openAiSettings(), anthropicSettings()], activeProfileId: 'openai-profile' })
  updateAiProfile.mockResolvedValue(openAiSettings())
  createAiProfile.mockResolvedValue({ ...anthropicSettings(), id: 'new-profile', name: 'New' })
  activateAiProfile.mockImplementation(async (id: string) => ({ activeProfileId: id }))
  deleteAiProfile.mockResolvedValue({ deleted: true })
  testAiProfileConnection.mockResolvedValue({ ok: true, provider: 'openai', model: 'agnes-2.5-flash', checkedAt: 1, latencyMs: 326 })
  getMetadataMigrationStatus.mockResolvedValue(migration)
  getFrontmatterCleanupPreview.mockResolvedValue({ candidates: [], blocked: [] })
  listManagedTags.mockResolvedValue([])
  getUndoAvailability.mockRejectedValue(Object.assign(new Error('undo unavailable'), { code: 'UNDO_UNAVAILABLE' }))
  listAttachments.mockResolvedValue({
    items: [], total: 0, offset: 0, limit: 30,
    summary: {
      total: 0, knownBytes: 0, unknownByteSizeCount: 0, unknownReferenceCount: 0, complete: true,
      sources: {
        'board-asset': { count: 0, knownBytes: 0 },
        'vault-file': { count: 0, knownBytes: 0 },
        'board-material': { count: 0, knownBytes: 0 },
      },
    },
    indexStatus: {
      ready: true, refreshing: false, complete: true, refreshedAt: 1,
      sources: {
        'board-asset': { state: 'ready', itemCount: 0 },
        'vault-file': { state: 'ready', itemCount: 0 },
        'board-material': { state: 'ready', itemCount: 0 },
      },
    },
  })
  refreshAttachmentIndex.mockResolvedValue({ indexStatus: { ready: true } })
  cleanDocumentFrontmatter.mockResolvedValue({ changed: [], failed: [] })
  restoreDocumentFrontmatter.mockResolvedValue({ changed: [], failed: [] })
  confirm.mockResolvedValue(true)
  loadActive.mockResolvedValue(undefined)
  loadSettings.mockResolvedValue(undefined)
  deactivateFocusTrap.mockResolvedValue(undefined)
  useEditorPreferences().reset()
  useFileTreePreferences().compactFileTree.value = true
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
  useI18n().setLocale('zh')
})

describe('SettingsModal', () => {
  it('opens on AI with active navigation, real providers, URL placeholder, and saved-key status', async () => {
    const wrapper = mountSettings()
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('设置')
    expect(document.body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('AI')
    expect(document.body.textContent).toContain('命名配置与默认模型')
    expect(document.body.textContent).toContain('配置')

    const provider = wrapper.getComponent(NSelect)
    expect(provider.props('to')).toBe('.settings-backdrop')
    expect(provider.props('options')).toEqual([
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'openai', label: 'OpenAI' },
    ])
    expect(provider.props('value')).toBe('openai')

    const keyInput = fieldControl<HTMLInputElement>('API Key', 'input')
    expect(keyInput.value).toBe('')
    expect(keyInput.placeholder).toBe('••••••••••••••••abcd')
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('已保存')
    expect(fieldControl<HTMLInputElement>('Base URL', 'input').placeholder).toBe('https://api.openai.com/v1')

    inputValue(keyInput, 'replacement-key')
    await flushPromises()
    expect(document.body.querySelector('.settings-key-status')).toBeNull()
  })

  it('opens the Attachment Manager from Storage settings and returns without closing Settings', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    const currentUrl = window.location.href

    findButton('存储与附件').click()
    await flushPromises()

    expect(document.body.querySelector('.settings-modal')?.classList.contains('is-attachment-manager')).toBe(true)
    expect(document.body.textContent).toContain('附件管理')
    expect(document.body.textContent).toContain('还没有可管理的附件')
    expect(listAttachments).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 30 }))
    expect(window.location.href).toBe(currentUrl)

    findButton('返回设置').click()
    await flushPromises()
    expect(document.body.querySelector('.settings-modal')?.classList.contains('is-attachment-manager')).toBe(false)
    expect(document.body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('AI')
    expect(wrapper.exists()).toBe(true)
  })

  it('does not test automatically and shows a real probe result after clicking Test connection', async () => {
    mountSettings()
    await flushPromises()

    expect(testAiProfileConnection).not.toHaveBeenCalled()
    findButton('测试连接').click()
    await flushPromises()

    expect(testAiProfileConnection).toHaveBeenCalledWith('openai-profile', {
      name: 'Agnes AI',
      provider: 'openai',
      baseURL: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
    }, expect.any(AbortSignal))
    expect(document.body.querySelector('.settings-connection-status')?.textContent).toContain('已连接')
    expect(document.body.querySelector('.settings-connection-status')?.textContent).toContain('326 ms')
  })

  it('resets a connected status when the displayed configuration changes', async () => {
    mountSettings()
    await flushPromises()
    findButton('测试连接').click()
    await flushPromises()
    expect(document.body.textContent).toContain('已连接')

    inputValue(fieldControl<HTMLInputElement>('模型', 'input'), 'new-model')
    await flushPromises()
    expect(document.body.querySelector('.settings-connection-status')?.textContent).toContain('未检测')
    expect(document.body.textContent).not.toContain('326 ms')
  })

  it('shows a safe failure state when the probe is rejected', async () => {
    testAiProfileConnection.mockRejectedValueOnce(Object.assign(new Error('upstream details'), {
      code: 'ai-authentication-failed',
    }))
    mountSettings()
    await flushPromises()
    findButton('测试连接').click()
    await flushPromises()

    const status = document.body.querySelector('.settings-connection-status')
    expect(status?.textContent).toContain('连接失败')
    expect(status?.textContent).toContain('认证失败，请检查 API Key。')
  })

  it('aborts an in-flight probe when the modal closes', async () => {
    let signal: AbortSignal | undefined
    testAiProfileConnection.mockImplementationOnce((_id: string, _input: unknown, nextSignal: AbortSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    })
    mountSettings()
    await flushPromises()
    findButton('测试连接').click()
    await flushPromises()
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click()
    expect(signal?.aborted).toBe(true)
  })

  it('changes protocol locally without activating another profile and keeps the optional Anthropic URL placeholder', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    const provider = wrapper.getComponent(NSelect)
    provider.vm.$emit('update:value', 'anthropic')
    await flushPromises()
    expect(activateAiProfile).not.toHaveBeenCalled()
    expect(updateAiProfile).not.toHaveBeenCalled()
    expect(provider.props('value')).toBe('anthropic')
    expect(fieldControl<HTMLInputElement>('Base URL', 'input').placeholder).toBe('可选')
    findButton('保存').click()
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('确认将此凭据用于另一种协议？', expect.any(String))
    expect(updateAiProfile).toHaveBeenCalledWith('openai-profile', expect.objectContaining({ provider: 'anthropic', confirmProviderChange: true }), expect.any(AbortSignal))
  })

  it('saves edited AI fields without changing the existing settings payload semantics', async () => {
    mountSettings()
    await flushPromises()

    inputValue(fieldControl<HTMLInputElement>('API Key', 'input'), 'sk-new')
    inputValue(fieldControl<HTMLInputElement>('Base URL', 'input'), 'https://example.test/v1')
    inputValue(fieldControl<HTMLInputElement>('模型', 'input'), 'third-party-model')
    await flushPromises()
    findButton('保存').click()
    await flushPromises()

    expect(updateAiProfile).toHaveBeenCalledWith('openai-profile', {
      name: 'Agnes AI', provider: 'openai',
      apiKey: 'sk-new',
      baseURL: 'https://example.test/v1',
      model: 'third-party-model',
    }, expect.any(AbortSignal))
    expect(loadSettings).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('AI 设置已保存')
  })

  it('keeps Clear Key behind a profile-specific destructive confirmation', async () => {
    mountSettings()
    await flushPromises()
    findButton('清除 Key').click()
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('清除「Agnes AI」（openai）的 API Key？', expect.any(String), expect.objectContaining({ destructive: true }))
    expect(updateAiProfile).toHaveBeenCalledWith('openai-profile', { clearKey: true }, expect.any(AbortSignal))
  })

  it.each(['master-key-required', 'master-key-invalid', 'master-key-file-unreadable', 'stored-key-invalid'])('keeps metadata and targeted credential recovery available for %s', async (code) => {
    getAiProfiles.mockResolvedValueOnce({ profiles: [{ ...openAiSettings(), credentialError: code }], activeProfileId: 'openai-profile' })
    mountSettings()
    await flushPromises()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(code)
    expect(fieldControl<HTMLInputElement>('名称', 'input').value).toBe('Agnes AI')
    expect(findButton('清除 Key').disabled).toBe(false)
    expect(findButton('设为默认').disabled).toBe(true)
  })

  it('retains entered fields and offers explicit retry after a failed save', async () => {
    updateAiProfile.mockRejectedValueOnce(Object.assign(new Error('master key mismatch'), { code: 'master-key-invalid' }))
    mountSettings()
    await flushPromises()
    inputValue(fieldControl<HTMLInputElement>('API Key', 'input'), 'replacement-key')
    inputValue(fieldControl<HTMLInputElement>('模型', 'input'), 'unsaved-model')
    findButton('保存').click()
    await flushPromises()
    expect(fieldControl<HTMLInputElement>('API Key', 'input').value).toBe('replacement-key')
    expect(fieldControl<HTMLInputElement>('模型', 'input').value).toBe('unsaved-model')
    expect(toastError).toHaveBeenCalled()
    expect(findButton('保存').disabled).toBe(false)
  })

  it('preserves unsaved fields on cancelled switching or closing and never carries an entered key to another profile', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    inputValue(fieldControl<HTMLInputElement>('API Key', 'input'), 'sk-unsaved')
    const target = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.settings-ai-profile')).find((el) => el.textContent?.includes('MiniMax'))!
    confirm.mockResolvedValueOnce(false)
    target.click()
    await flushPromises()
    expect(fieldControl<HTMLInputElement>('API Key', 'input').value).toBe('sk-unsaved')
    confirm.mockResolvedValueOnce(false)
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    target.click()
    await flushPromises()
    expect(fieldControl<HTMLInputElement>('名称', 'input').value).toBe('MiniMax')
    expect(fieldControl<HTMLInputElement>('API Key', 'input').value).toBe('')
    expect(activateAiProfile).not.toHaveBeenCalled()
  })

  it('creates a named profile without implicitly activating it', async () => {
    mountSettings()
    await flushPromises()
    findButton('新增配置').click()
    await flushPromises()
    inputValue(fieldControl<HTMLInputElement>('名称', 'input'), 'New')
    inputValue(fieldControl<HTMLInputElement>('API Key', 'input'), 'sk-new')
    await flushPromises()
    findButton('保存').click()
    await flushPromises()
    expect(createAiProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'New', provider: 'anthropic', apiKey: 'sk-new' }), expect.any(AbortSignal))
    expect(activateAiProfile).not.toHaveBeenCalled()
    expect(fieldControl<HTMLInputElement>('API Key', 'input').value).toBe('')
    expect(document.body.querySelector('.settings-ai-profile.is-selected')?.textContent).toContain('New')
  })

  it('activates only by explicit action and refreshes the displayed runtime model', async () => {
    mountSettings()
    await flushPromises()
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('.settings-ai-profile')).find((el) => el.textContent?.includes('MiniMax'))!.click()
    await flushPromises()
    findButton('设为默认').click()
    await flushPromises()
    expect(activateAiProfile).toHaveBeenCalledWith('anthropic-profile', expect.any(AbortSignal))
    expect(loadSettings).toHaveBeenCalled()
    expect(document.body.querySelector('.settings-ai-profile.is-selected .settings-ai-profile-default')?.textContent).toBe('默认')
  })

  it('requires explicit confirmation to delete a default profile and disables AI rather than selecting another default', async () => {
    mountSettings()
    await flushPromises()
    findButton('删除').click()
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('删除配置「Agnes AI」（openai）？', expect.stringContaining('禁用 AI'), expect.objectContaining({ destructive: true }))
    expect(deleteAiProfile).toHaveBeenCalledWith('openai-profile', true, expect.any(AbortSignal))
    expect(document.body.querySelectorAll('.settings-ai-profile-default')).toHaveLength(0)
    expect(document.body.querySelectorAll('.settings-ai-profile')).toHaveLength(1)
  })

  it('ignores a late connection result after switching to another profile', async () => {
    let resolve!: (value: unknown) => void
    testAiProfileConnection.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    mountSettings()
    await flushPromises()
    findButton('测试连接').click()
    await flushPromises()
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('.settings-ai-profile')).find((el) => el.textContent?.includes('MiniMax'))!.click()
    await flushPromises()
    resolve({ ok: true, provider: 'openai', model: 'old-model', checkedAt: 1, latencyMs: 42 })
    await flushPromises()
    expect(document.body.querySelector('.settings-connection-status')?.textContent).toContain('未检测')
    expect(document.body.textContent).not.toContain('old-model')
  })

  it('switches to the Editor and Metadata sections without changing their behavior surfaces', async () => {
    const wrapper = mountSettings({ withTags: true })
    await flushPromises()

    findButton('编辑器').click()
    await flushPromises()
    expect(document.body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('编辑器')
    expect(document.body.textContent).toContain('此设备上的 Monaco 偏好设置')
    expect(document.body.textContent).toContain('编辑器偏好')
    expect(wrapper.findAllComponents(NInputNumber)).toHaveLength(3)

    findButton('文档元数据').click()
    await flushPromises()
    expect(document.body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('文档元数据')
    expect(document.body.textContent).toContain('SQLite 迁移与 Frontmatter 安全检查')
    expect(document.body.textContent).toContain('迁移状态')
    expect(document.body.textContent).toContain('3 已验证')

    findButton('标签').click()
    await flushPromises()
    expect(document.body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('标签')
    expect(document.body.textContent).toContain('管理标签并撤销最近一次更改')
    const settings = document.body.querySelector<HTMLElement>('.settings-modal')!
    expect(settings.querySelector('[data-tag-management-panel]')).toBeTruthy()
    expect(settings.querySelector('[data-action="manage-tags"]')).toBeNull()
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('preserves Naive number bounds and exact numeric/boolean editor preference types', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    findButton('编辑器').click()
    await flushPromises()

    const numberInputs = wrapper.findAllComponents(NInputNumber)
    expect(numberInputs.map((control) => [control.props('min'), control.props('max')])).toEqual([
      [11, 24],
      [16, 40],
      [60, 160],
    ])

    const tabSize = wrapper.getComponent(NSelect)
    expect(tabSize.props('options')).toEqual([
      { value: 2, label: '2 个空格' },
      { value: 4, label: '4 个空格' },
    ])
    tabSize.vm.$emit('update:value', 4)
    await flushPromises()
    expect(useEditorPreferences().tabSize.value).toBe(4)
    expect(typeof useEditorPreferences().tabSize.value).toBe('number')

    const checkboxes = wrapper.findAllComponents(NCheckbox)
    expect(checkboxes).toHaveLength(2)
    checkboxes[0].vm.$emit('update:checked', false)
    checkboxes[1].vm.$emit('update:checked', false)
    await flushPromises()
    expect(useEditorPreferences().typography.value).toBe(false)
    expect(useFileTreePreferences().compactFileTree.value).toBe(false)
  })

  it('focuses the first real settings input after opening', async () => {
    const wrapper = mount(SettingsModal, {
      props: { open: false },
      attachTo: document.body,
    })
    wrappers.push(wrapper)

    await wrapper.setProps({ open: true })
    await flushPromises()
    const firstInput = document.body.querySelector<HTMLInputElement>('.settings-modal input:not([disabled])')
    expect(firstInput).toBeTruthy()
    expect(document.activeElement).toBe(firstInput)
  })

  it('closes on Escape and continues routing Tab through the focus trap', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(activateFocusTrap).toHaveBeenCalledTimes(1)

    const backdrop = document.body.querySelector<HTMLElement>('.settings-backdrop')!
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(onFocusTrapTab).toHaveBeenCalledTimes(1)

    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(deactivateFocusTrap).toHaveBeenCalled()
  })

  it('does not unmount the active Tags page while its host reports an unsafe leave', async () => {
    const wrapper = mount(SettingsModal, {
      props: { open: true, activeSectionCanLeave: false },
      slots: { tags: () => h('section', { 'data-tag-management-panel': true }) },
      attachTo: document.body,
    })
    wrappers.push(wrapper)
    await flushPromises()

    findButton('标签').click()
    await flushPromises()
    findButton('编辑器').click()
    expect(document.body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('标签')

    document.body.querySelector<HTMLElement>('.settings-icon-btn')!.click()
    expect(wrapper.emitted('close')).toBeUndefined()

    await wrapper.setProps({ activeSectionCanLeave: true })
    document.body.querySelector<HTMLElement>('.settings-icon-btn')!.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
