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

const getAiSettings = vi.fn()
const getAiCredentialStatus = vi.fn()
const saveAiSettings = vi.fn()
const clearAiApiKey = vi.fn()
const testAiConnection = vi.fn()
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

vi.mock('../../../lib/ai-api', () => ({
  getAiSettings: (...args: unknown[]) => getAiSettings(...args),
  getAiCredentialStatus: (...args: unknown[]) => getAiCredentialStatus(...args),
  saveAiSettings: (...args: unknown[]) => saveAiSettings(...args),
  clearAiApiKey: (...args: unknown[]) => clearAiApiKey(...args),
  testAiConnection: (...args: unknown[]) => testAiConnection(...args),
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

vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}))

vi.mock('../../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm }),
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
  provider: 'openai' as const,
  configured: true,
  source: 'db' as const,
  maskedKey: '••••••••••••••••abcd',
  baseURL: 'https://apihub.agnes-ai.com/v1',
  model: 'agnes-2.5-flash',
})

const anthropicSettings = () => ({
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
  getAiSettings.mockResolvedValue(openAiSettings())
  getAiCredentialStatus.mockResolvedValue({
    provider: 'openai',
    providers: { anthropic: { stored: false }, openai: { stored: true } },
  })
  saveAiSettings.mockResolvedValue(openAiSettings())
  clearAiApiKey.mockResolvedValue({ cleared: true, provider: 'openai' })
  testAiConnection.mockResolvedValue({
    ok: true,
    provider: 'openai',
    model: 'agnes-2.5-flash',
    checkedAt: 1,
    latencyMs: 326,
  })
  getMetadataMigrationStatus.mockResolvedValue(migration)
  getFrontmatterCleanupPreview.mockResolvedValue({ candidates: [], blocked: [] })
  listManagedTags.mockResolvedValue([])
  getUndoAvailability.mockRejectedValue(Object.assign(new Error('undo unavailable'), { code: 'UNDO_UNAVAILABLE' }))
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
    expect(document.body.textContent).toContain('AI 提供商配置')
    expect(document.body.textContent).toContain('配置')

    const provider = wrapper.getComponent(NSelect)
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

  it('does not test automatically and shows a real probe result after clicking Test connection', async () => {
    mountSettings()
    await flushPromises()

    expect(testAiConnection).not.toHaveBeenCalled()
    findButton('测试连接').click()
    await flushPromises()

    expect(testAiConnection).toHaveBeenCalledWith({
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
    testAiConnection.mockRejectedValueOnce(Object.assign(new Error('upstream details'), {
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
    testAiConnection.mockImplementationOnce((_input: unknown, nextSignal: AbortSignal) => {
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

  it('switches providers through the existing save call and uses the optional URL placeholder for Anthropic', async () => {
    saveAiSettings.mockResolvedValueOnce(anthropicSettings())
    const wrapper = mountSettings()
    await flushPromises()

    const provider = wrapper.getComponent(NSelect)
    provider.vm.$emit('update:value', 'anthropic')
    await flushPromises()

    expect(saveAiSettings).toHaveBeenCalledWith({ provider: 'anthropic' })
    expect(provider.props('value')).toBe('anthropic')
    expect(fieldControl<HTMLInputElement>('模型', 'input').value).toBe('claude-sonnet-4-6')
    expect(fieldControl<HTMLInputElement>('Base URL', 'input').placeholder).toBe('可选')
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

    expect(saveAiSettings).toHaveBeenCalledWith({
      apiKey: 'sk-new',
      baseURL: 'https://example.test/v1',
      model: 'third-party-model',
    })
    expect(loadSettings).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('AI 设置已保存')
  })

  it('keeps Clear Key behind the destructive confirmation flow', async () => {
    mountSettings()
    await flushPromises()

    findButton('清除 Key').click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      '永久删除 openai 保存的 API Key？',
      '即使之后找回原 master key，也无法恢复已删除的加密凭据。',
      expect.objectContaining({
        confirmLabel: '永久删除',
        cancelLabel: '取消',
        destructive: true,
      }),
    )
    expect(clearAiApiKey).toHaveBeenCalledWith('openai')
  })

  it('renders the master-key recovery warning and stored-provider forget action', async () => {
    getAiSettings.mockRejectedValue(Object.assign(new Error('master key required'), {
      code: 'master-key-required',
    }))
    mountSettings()
    await flushPromises()

    const alert = document.body.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('找不到用于解密现有 AI 凭据的主密钥')
    expect(alert?.textContent).toContain('data/.nuvyn-master-key')
    expect(findButton('放弃 openai API Key')).toBeTruthy()
    expect(document.body.textContent).not.toContain('放弃 anthropic API Key')
    expect(getAiCredentialStatus).toHaveBeenCalled()
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
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
