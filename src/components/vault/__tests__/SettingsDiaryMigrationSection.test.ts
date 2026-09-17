// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import type { MigrationStatus } from '../../../lib/diary-migration-api'
import SettingsDiaryMigrationSection from '../SettingsDiaryMigrationSection.vue'

const getDiaryMigrationStatus = vi.fn()
const resolveDiaryMigrationItem = vi.fn()
const resumeDiaryMigration = vi.fn()
const scanDiaryMigration = vi.fn()
const startDiaryMigration = vi.fn()
const prompt = vi.fn()
const inspectManagedDiaryRecovery = vi.fn()
const deleteManagedDraftIfUnchanged = vi.fn()
const deleteManagedConflictDraftIfUnchanged = vi.fn()
const getPost = vi.fn()
const savePost = vi.fn()
const toastSuccess = vi.fn()

vi.mock('../../../lib/diary-migration-api', () => ({
  getDiaryMigrationStatus: (...args: unknown[]) => getDiaryMigrationStatus(...args),
  resolveDiaryMigrationItem: (...args: unknown[]) => resolveDiaryMigrationItem(...args),
  resumeDiaryMigration: (...args: unknown[]) => resumeDiaryMigration(...args),
  scanDiaryMigration: (...args: unknown[]) => scanDiaryMigration(...args),
  startDiaryMigration: (...args: unknown[]) => startDiaryMigration(...args),
}))

vi.mock('../../../composables/usePrompt', () => ({
  usePrompt: () => ({ prompt }),
}))

vi.mock('../../../composables/useToast', () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}))

vi.mock('../../../composables/vault/context/useVaultContext', () => ({
  useOptionalVaultContext: () => ({ vaultId: { value: 'vault-1' } }),
}))

vi.mock('../../../composables/vault/draft-recovery/draftStore', () => ({
  createDraftStore: () => ({
    inspectManagedDiaryRecovery,
    deleteManagedDraftIfUnchanged,
    deleteManagedConflictDraftIfUnchanged,
  }),
}))

vi.mock('../../../lib/api', () => ({
  getPost: (...args: unknown[]) => getPost(...args),
  savePost: (...args: unknown[]) => savePost(...args),
}))

const migrationStatus = {
  runId: 'run-1',
  vaultId: 'vault-1',
  inventoryRevision: 3,
  state: 'SCANNED',
  counts: { total: 1 },
  items: [{
    itemKey: 'diary-2026-08-24',
    documentId: 'document-1',
    canonicalPath: 'diary/2026-08-24',
    classification: 'CLEANUP_PENDING',
    state: 'PUBLISHED',
    migrationFinalizeCapability: 'USER_FINALIZE_REQUIRED' as const,
  }],
  migrationFinalizeCapability: 'USER_FINALIZE_REQUIRED' as const,
  residuals: {
    gitRetentionAcknowledged: false,
    userControlledPlaintextResidual: 0,
    policyRetainedAiHistory: 0,
  },
}

const draft = {
  version: 1 as const,
  vaultId: 'vault-1',
  documentId: 'document-1',
  documentPath: 'diary/2026-08-24.md',
  content: '# legacy draft',
  baseContentHash: null,
  baseModifiedAt: null,
  createdAt: 10,
  updatedAt: 11,
}

enableAutoUnmount(afterEach)

function item(overrides: Partial<typeof migrationStatus.items[number]> = {}) {
  return { ...migrationStatus.items[0]!, ...overrides }
}

function statusWithItems(items: Array<ReturnType<typeof item>>) {
  return { ...migrationStatus, counts: { total: items.length }, items }
}

function mountSection(status: MigrationStatus = migrationStatus): VueWrapper {
  getDiaryMigrationStatus.mockResolvedValue(status)
  return mount(SettingsDiaryMigrationSection, { attachTo: document.body })
}

function buttonByText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find((button) => button.text().includes(text))
}

function discardButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').find((button) => button.text().includes('Discard draft'))
}

describe('SettingsDiaryMigrationSection', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    vi.clearAllMocks()
    getDiaryMigrationStatus.mockResolvedValue(migrationStatus)
    resolveDiaryMigrationItem.mockResolvedValue(migrationStatus)
    resumeDiaryMigration.mockResolvedValue(migrationStatus)
    scanDiaryMigration.mockResolvedValue({ runId: 'run-1', inventoryRevision: 3, state: 'SCANNED', counts: { total: 1 } })
    startDiaryMigration.mockResolvedValue(migrationStatus)
    inspectManagedDiaryRecovery.mockResolvedValue({
      status: 'ok',
      inventory: { primary: [draft], conflicts: [] },
    })
    deleteManagedDraftIfUnchanged.mockResolvedValue({ status: 'deleted' })
    deleteManagedConflictDraftIfUnchanged.mockResolvedValue({ status: 'deleted' })
    prompt.mockResolvedValue(null)
  })

  afterEach(() => {
    useI18n().setLocale('zh')
    document.body.innerHTML = ''
  })

  it('renders migration actions as native NButton roots without changing the existing labels', async () => {
    const wrapper = mountSection()
    await flushPromises()

    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((button) => button.element.classList.contains('n-button'))).toBe(true)
    expect(buttons.every((button) => button.attributes('type') === 'button')).toBe(true)
    expect(wrapper.text()).toContain('Discard draft with confirmation')
  })

  it('keeps cancel and wrong confirmation answers side-effect free', async () => {
    const wrapper = mountSection()
    await flushPromises()
    const button = discardButton(wrapper)
    expect(button).toBeDefined()

    prompt.mockResolvedValueOnce(null)
    await button!.trigger('click')
    await flushPromises()
    prompt.mockResolvedValueOnce('discard legacy diary recovery')
    await button!.trigger('click')
    await flushPromises()

    expect(prompt).toHaveBeenCalledTimes(2)
    expect(deleteManagedDraftIfUnchanged).not.toHaveBeenCalled()
    expect(resolveDiaryMigrationItem).not.toHaveBeenCalled()
  })

  it('does not enqueue a second destructive request while confirmation is pending', async () => {
    const wrapper = mountSection()
    await flushPromises()
    const button = discardButton(wrapper)
    expect(button).toBeDefined()
    let answer!: (value: string | null) => void
    prompt.mockReturnValueOnce(new Promise<string | null>((resolve) => { answer = resolve }))

    await button!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(button!.attributes('disabled')).toBeDefined()

    await button!.trigger('click')
    expect(prompt).toHaveBeenCalledTimes(1)
    answer(null)
    await flushPromises()
    expect(deleteManagedDraftIfUnchanged).not.toHaveBeenCalled()
    expect(resolveDiaryMigrationItem).not.toHaveBeenCalled()
  })

  it('uses the exact confirmation phrase before conditional deletion and resolve', async () => {
    const wrapper = mountSection()
    await flushPromises()
    const button = discardButton(wrapper)
    expect(button).toBeDefined()
    const phrase = 'DISCARD LEGACY DIARY RECOVERY'
    prompt.mockResolvedValueOnce(phrase)

    await button!.trigger('click')
    await flushPromises()

    expect(prompt).toHaveBeenCalledWith({
      title: `Type ${phrase} to confirm`,
      placeholder: phrase,
      actionLabel: 'Confirm',
      actionTitle: 'Confirm',
    })
    expect(deleteManagedDraftIfUnchanged).toHaveBeenCalledWith(draft)
    expect(resolveDiaryMigrationItem).toHaveBeenCalledWith(
      'run-1',
      'diary-2026-08-24',
      3,
      'discard-draft',
      phrase,
    )
  })

  it('loads, scans, resumes, and derives the frozen start scopes', async () => {
    const status = statusWithItems([
      item({ itemKey: 'legacy-plaintext', classification: 'LEGACY_PLAINTEXT', canonicalPath: 'legacy/plaintext' }),
      item({ itemKey: 'needs-unlock', classification: 'NEEDS_UNLOCK', canonicalPath: 'legacy/unlock' }),
      item({ itemKey: 'recovery-auth', classification: 'RECOVERY_AUTH_REQUIRED', canonicalPath: 'legacy/auth' }),
      item({ itemKey: 'cleanup', classification: 'CLEANUP_PENDING', canonicalPath: 'diary/2026-08-25' }),
      item({ itemKey: 'retention', classification: 'NEEDS_ATTENTION', canonicalPath: '@git/retention' }),
    ])
    const wrapper = mountSection(status)
    await flushPromises()

    await buttonByText(wrapper, 'Scan legacy Diary state')!.trigger('click')
    await flushPromises()
    expect(scanDiaryMigration).toHaveBeenCalledTimes(1)
    expect(getDiaryMigrationStatus).toHaveBeenCalledTimes(2)
    expect(toastSuccess).toHaveBeenCalledWith('Diary migration inventory created')

    await buttonByText(wrapper, 'Prepare encrypted migration')!.trigger('click')
    await flushPromises()
    expect(startDiaryMigration).toHaveBeenCalledWith('run-1', 3, [
      { itemKey: 'legacy-plaintext', scope: 'MIGRATE_PRIMARY' },
      { itemKey: 'needs-unlock', scope: 'MIGRATE_PRIMARY' },
      { itemKey: 'recovery-auth', scope: 'MIGRATE_PRIMARY' },
      { itemKey: 'cleanup', scope: 'CLEAN_PRIVATE_SQLITE' },
      { itemKey: 'retention', scope: 'ACKNOWLEDGE_GIT_RETENTION' },
    ])

    await buttonByText(wrapper, 'Resume verification')!.trigger('click')
    await flushPromises()
    expect(resumeDiaryMigration).toHaveBeenCalledWith('run-1', 3)
  })

  it('requires both runId and inventoryRevision before enabling run actions', async () => {
    const notReadyStatus = {
      ...migrationStatus,
      runId: null,
      inventoryRevision: undefined,
    } as MigrationStatus
    const wrapper = mountSection(notReadyStatus)
    await flushPromises()

    expect(buttonByText(wrapper, 'Prepare encrypted migration')!.attributes('disabled')).toBeDefined()
    expect(buttonByText(wrapper, 'Resume verification')!.attributes('disabled')).toBeDefined()
  })

  it('disables every migration action while a mutation is in flight', async () => {
    let finish!: (value: typeof migrationStatus) => void
    startDiaryMigration.mockReturnValueOnce(new Promise<typeof migrationStatus>((resolve) => { finish = resolve }))
    const wrapper = mountSection()
    await flushPromises()

    await buttonByText(wrapper, 'Prepare encrypted migration')!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('button').every((button) => button.attributes('disabled') !== undefined)).toBe(true)

    finish(migrationStatus)
    await flushPromises()
  })

  it('imports a managed draft before conditional deletion and item resolution', async () => {
    getPost.mockResolvedValue({ raw: '# current diary' })
    savePost.mockResolvedValue({})
    const wrapper = mountSection()
    await flushPromises()

    await buttonByText(wrapper, 'Import into encrypted Diary')!.trigger('click')
    await flushPromises()

    expect(getPost).toHaveBeenCalledWith('diary/2026-08-24')
    expect(savePost).toHaveBeenCalledWith('diary/2026-08-24', draft.content, '# current diary')
    expect(deleteManagedDraftIfUnchanged).toHaveBeenCalledWith(draft)
    expect(resolveDiaryMigrationItem).toHaveBeenCalledWith(
      'run-1',
      'diary-2026-08-24',
      3,
      'import-to-primary',
    )
  })

  it('fails closed on a conditional-delete race and reloads the migration status', async () => {
    getDiaryMigrationStatus.mockResolvedValue(migrationStatus)
    getPost.mockResolvedValue({ raw: '# current diary' })
    deleteManagedDraftIfUnchanged.mockResolvedValue({ status: 'stale' })
    const wrapper = mountSection()
    await flushPromises()

    await buttonByText(wrapper, 'Import into encrypted Diary')!.trigger('click')
    await flushPromises()

    expect(resolveDiaryMigrationItem).not.toHaveBeenCalled()
    expect(deleteManagedDraftIfUnchanged).toHaveBeenCalledWith(draft)
    expect(getDiaryMigrationStatus).toHaveBeenCalledTimes(2)
  })

  it('preserves the classification-specific resolve actions', async () => {
    const cases = [
      ['METADATA_MISSING', 'Adopt metadata identity', 'adopt-metadata'],
      ['LEGACY_DIARY_AI_HISTORY', 'Retain AI history', 'retain-ai-history'],
      ['LEGACY_DIARY_AI_HISTORY', 'Discard AI session', 'discard-ai-session'],
      ['FRONTMATTER_IDENTITY_UNRESOLVED', 'Bind Frontmatter identity', 'bind-frontmatter-identity'],
      ['NEEDS_ATTENTION', 'Retry migration', 'retry-item'],
      ['OTHER', 'Acknowledge attention', 'acknowledge-attention'],
    ] as const

    for (const [classification, label, action] of cases) {
      vi.clearAllMocks()
      const caseStatus = statusWithItems([item({
        itemKey: `item-${classification}-${action}`,
        classification,
        state: classification === 'OTHER' ? 'NEEDS_ATTENTION' : 'PUBLISHED',
        canonicalPath: `legacy/${classification.toLowerCase()}`,
      })])
      resolveDiaryMigrationItem.mockResolvedValue(migrationStatus)
      inspectManagedDiaryRecovery.mockResolvedValue({ status: 'ok', inventory: { primary: [], conflicts: [] } })
      const wrapper = mountSection(caseStatus)
      await flushPromises()
      await buttonByText(wrapper, label)!.trigger('click')
      await flushPromises()
      expect(resolveDiaryMigrationItem).toHaveBeenCalledWith(
        'run-1',
        `item-${classification}-${action}`,
        3,
        action,
        undefined,
      )
      wrapper.unmount()
    }
  })

  it('acknowledges a retained plaintext residual through the existing start scope', async () => {
    const wrapper = mountSection(statusWithItems([item({
      itemKey: 'plaintext-residual',
      classification: 'USER_FINALIZE_REQUIRED',
      state: 'PUBLISHED',
      canonicalPath: 'diary/2026-08-26',
    })]))
    await flushPromises()

    await buttonByText(wrapper, 'Acknowledge retained plaintext copy')!.trigger('click')
    await flushPromises()
    expect(startDiaryMigration).toHaveBeenCalledWith('run-1', 3, [{
      itemKey: 'plaintext-residual',
      scope: 'REMOVE_VERIFIED_LEGACY_PRIMARY',
    }])
  })

  it('surfaces scan errors without changing the migration state machine', async () => {
    scanDiaryMigration.mockRejectedValueOnce(Object.assign(new Error('scan failed'), { code: 'scan-failed' }))
    const wrapper = mountSection()
    await flushPromises()

    await buttonByText(wrapper, 'Scan legacy Diary state')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('scan-failed')
    expect(getDiaryMigrationStatus).toHaveBeenCalledTimes(1)
  })
})
