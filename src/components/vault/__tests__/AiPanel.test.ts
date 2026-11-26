// @vitest-environment jsdom
import { defineComponent, h, nextTick, provide, ref, type Ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShellContextKey, type NoteAiContextBridge } from '../../../composables/appShellContext'
import type { AiLiveContextCapture, AiDocumentContext, AiLiveContextSnapshot } from '../../../composables/vault/aiLiveContext'
import { useAiHistory, useLedgerAiHistory } from '../../../composables/vault/useAiHistory'
import { useI18n } from '../../../composables/useI18n'
import AiPanel from '../AiPanel.vue'
import AiChatMessages from '../AiChatMessages.vue'
import AiComposer from '../AiComposer.vue'
import { getAiProfiles, getFinanceMemory, getFinanceSkill, getFinanceSkills, runLedgerAiCommand } from '../../../lib/ai-api'

vi.mock('../../../lib/ai-api', async (original) => ({
  ...await original<typeof import('../../../lib/ai-api')>(),
  getAiProfiles: vi.fn(),
  getFinanceMemory: vi.fn(),
  getFinanceSkill: vi.fn(),
  getFinanceSkills: vi.fn(),
  updateFinanceMemory: vi.fn(),
  deleteFinanceMemory: vi.fn(),
  clearFinanceMemory: vi.fn(),
  runLedgerAiCommand: vi.fn(),
}))

vi.mock('../../../composables/vault/useAiHistory', async () => {
  const { ref: vueRef } = await import('vue')
  const history = {
    activeSession: vueRef(null),
    messages: vueRef([]),
    threadScope: vueRef(null),
    sessions: vueRef([]),
    isLoading: vueRef(false),
    busy: vueRef(false),
    errorState: vueRef(null),
    financePhase: vueRef(null),
    configured: vueRef(true),
    model: vueRef('test-model'),
    loadActive: vi.fn(async () => {}),
    loadSettings: vi.fn(async () => {}),
    loadThread: vi.fn(async () => {}),
    clearThread: vi.fn(async () => {}),
    refreshModel: vi.fn(async () => {}),
    refreshSessions: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ id: 1, title: '', createdAt: 0, updatedAt: 0 })),
    switchSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    sendAndStream: vi.fn(async (_text: string, _opts?: { liveContext?: AiLiveContextSnapshot; publishFileChange?: (event: unknown) => void }) => {}),
    stop: vi.fn(),
  }
  const financeHistory = {
    ...history,
    activeSession: vueRef({ id: 27, title: 'AI Finance', createdAt: 0, updatedAt: 0 }),
    messages: vueRef([]),
    busy: vueRef(false),
    loadActive: vi.fn(async () => {}),
    sendAndStream: vi.fn(async () => {}),
  }
  return { useAiHistory: () => history, useLedgerAiHistory: () => financeHistory }
})

function documentCapture(path = 'notes/a.md'): AiLiveContextCapture {
  const context: AiDocumentContext = {
    v: 1,
    kind: 'document',
    capturedAt: 1,
    vaultId: 'vault-a',
    workspaceTabId: path,
    identity: { documentId: `doc:${path}`, path },
    title: path,
    raw: `body for ${path}`,
    revision: 1,
    savedRevision: 1,
    dirty: false,
    saveStatus: 'idle',
  }
  return { status: 'ready', context }
}

function mountPanel(
  capture: () => AiLiveContextCapture = () => ({ status: 'none' }),
  panelProps: Record<string, unknown> = {},
): { wrapper: VueWrapper; bridge: Ref<NoteAiContextBridge | null>; publishFileChange: ReturnType<typeof vi.fn> } {
  const publishFileChange = vi.fn()
  const bridge = ref<NoteAiContextBridge | null>({
    capture,
    publishFileChange,
    linkPaths: () => [],
    openLink: vi.fn(async () => {}),
  })
  const wrapper = mount(defineComponent({
    setup() {
      provide(AppShellContextKey, {
        settingsRequestTick: ref(0),
        noteAiContext: bridge,
      })
      return () => h(AiPanel, { open: true, ...panelProps })
    },
  }))
  return { wrapper, bridge, publishFileChange }
}

async function typeAndSend(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find('textarea').setValue(text)
  wrapper.findComponent(AiComposer).vm.$emit('send')
  await nextTick()
}

const history = useAiHistory()
const financeHistory = useLedgerAiHistory(history)
enableAutoUnmount(afterEach)

describe('global AI panel', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    history.configured.value = true
    history.busy.value = false
    history.isLoading.value = false
    history.activeSession.value = null
    history.messages.value = []
    financeHistory.messages.value = []
    financeHistory.busy.value = false
    vi.clearAllMocks()
    vi.mocked(getAiProfiles).mockResolvedValue({
      profiles: [
        { id: 'profile-default', name: 'Default', provider: 'anthropic', baseURL: '', model: 'claude-test', configured: true, maskedKey: '••••••••', createdAt: 1, updatedAt: 1 },
        { id: 'profile-openai', name: 'OpenAI profile', provider: 'openai', baseURL: '', model: 'MiniMax-M3.1-Flash', configured: true, maskedKey: '••••••••', createdAt: 2, updatedAt: 2 },
      ],
      activeProfileId: 'profile-default',
    })
    vi.mocked(getFinanceMemory).mockResolvedValue({
      items: [],
      usage: {
        user: { used: 0, limit: 2_000 },
        agent: { used: 0, limit: 3_000 },
        total: { used: 0, limit: 5_000 },
      },
    })
    vi.mocked(getFinanceSkills).mockResolvedValue([
      { name: 'monthly-review', title: 'Monthly review', description: 'Review monthly finances.', source: 'builtin' },
      { name: 'spending-analysis', title: 'Spending analysis', description: 'Analyze spending.', source: 'builtin' },
      { name: 'debt-analysis', title: 'Debt analysis', description: 'Analyze debt.', source: 'builtin' },
      { name: 'cashflow-analysis', title: 'Cashflow analysis', description: 'Analyze cashflow.', source: 'builtin' },
      { name: 'financial-planning', title: 'Financial planning', description: 'Plan finances.', source: 'builtin' },
    ])
    vi.mocked(getFinanceSkill).mockResolvedValue({
      name: 'monthly-review', title: 'Monthly review', description: 'Review monthly finances.', source: 'builtin', content: '# Monthly review',
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    useI18n().setLocale('zh')
  })

  it('loads the shared active conversation instead of selecting a Note thread on mount', async () => {
    mountPanel()
    await nextTick()
    expect(history.loadActive).toHaveBeenCalledOnce()
    expect(history.loadThread).not.toHaveBeenCalled()
  })

  it('does not flash the ordinary welcome while history is loading', async () => {
    history.isLoading.value = true
    const { wrapper } = mountPanel(undefined, { workspaceKind: 'vault' })
    await nextTick()
    expect(wrapper.findComponent(AiChatMessages).props('showWelcome')).toBe(false)
    history.isLoading.value = false
    await nextTick()
    expect(wrapper.findComponent(AiChatMessages).props('showWelcome')).toBe(true)
  })

  it('captures the current Note snapshot synchronously and sends no thread scope', async () => {
    const events: string[] = []
    const capture = documentCapture('notes/a.md')
    const captureSpy = vi.fn(() => {
      events.push('capture')
      return capture
    })
    const sendSpy = vi.spyOn(history, 'sendAndStream').mockImplementation(async () => {
      events.push('send')
    })
    const { wrapper } = mountPanel(captureSpy, { workspaceKind: 'vault' })
    await nextTick()
    events.length = 0
    captureSpy.mockClear()

    await typeAndSend(wrapper, 'hello')

    expect(events).toEqual(['capture', 'send'])
    expect(sendSpy).toHaveBeenCalledWith('hello', {
      profileId: 'profile-default',
      liveContext: (capture as { status: 'ready'; context: AiLiveContextSnapshot }).context,
      publishFileChange: expect.any(Function),
    })
    expect(sendSpy.mock.calls[0]?.[1]).not.toHaveProperty('threadScope')
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe('')
  })

  it('requests Ledger context even without financial keywords and excludes Note context', async () => {
    const sendSpy = vi.spyOn(financeHistory, 'sendAndStream').mockImplementation(async () => {})
    const capture = vi.fn(() => documentCapture())
    const { wrapper } = mountPanel(capture, { workspaceKind: 'ledger' })
    await typeAndSend(wrapper, 'hello from another workspace')
    expect(sendSpy).toHaveBeenCalledWith('hello from another workspace', { profileId: 'profile-default', ledgerAnalysis: true })
    expect(capture).not.toHaveBeenCalled()
    expect(wrapper.get('.ai-floating-title').text()).toBe('AI Finance')
    expect(wrapper.find('[data-testid="global-ai-new-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="global-ai-history"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="global-ai-close"]').exists()).toBe(true)
  })

  it('executes only the local commands and keeps existing messages until clear succeeds', async () => {
    const conversation = [{ id: 2, sessionId: 27, role: 'assistant' as const, content: 'Private answer', createdAt: 1 }]
    financeHistory.messages.value = conversation
    const command = vi.mocked(runLedgerAiCommand)
    const { wrapper } = mountPanel(undefined, { workspaceKind: 'ledger' })
    await typeAndSend(wrapper, '/missing')
    expect(wrapper.text()).toContain('Unknown command')
    expect(financeHistory.sendAndStream).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()

    let finish!: (value: { outcome: 'compacted' }) => void
    command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await typeAndSend(wrapper, '  /compact  ')
    expect(wrapper.text()).toContain('Compacting conversation')
    await typeAndSend(wrapper, '/compact')
    expect(command).toHaveBeenCalledOnce()
    expect(command.mock.calls[0]?.[0]).toBe('compact')
    expect(command.mock.calls[0]?.[2]).toBe('profile-default')
    finish({ outcome: 'compacted' })
    await nextTick()
    await nextTick()
    expect(wrapper.text()).toContain('Conversation compacted')
    expect(financeHistory.messages.value).toEqual(conversation)

    command.mockRejectedValueOnce(new Error('could not clear'))
    await typeAndSend(wrapper, '/clear')
    await flushPromises()
    expect(command).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('Command failed')
    expect(financeHistory.messages.value).toEqual(conversation)

    command.mockResolvedValueOnce({ outcome: 'cleared' })
    await typeAndSend(wrapper, '/clear')
    await flushPromises()
    expect(command).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toContain('Conversation cleared')
    expect(financeHistory.messages.value).toEqual([])
    expect(wrapper.get('h2').text()).toBe('What would you like to explore today?')
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe('')
  })

  it('opens finance memory locally without sending a chat request or modifying history', async () => {
    const conversation = [{ id: 2, sessionId: 27, role: 'assistant' as const, content: 'Existing finance answer', createdAt: 1 }]
    financeHistory.messages.value = conversation
    const { wrapper } = mountPanel(undefined, { workspaceKind: 'ledger' })
    await typeAndSend(wrapper, '/memory')
    await flushPromises()
    expect(getFinanceMemory).toHaveBeenCalledOnce()
    expect(runLedgerAiCommand).not.toHaveBeenCalled()
    expect(financeHistory.sendAndStream).not.toHaveBeenCalled()
    expect(financeHistory.messages.value).toEqual(conversation)
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe('')
  })

  it('opens finance skills locally without an LLM request or chat-history change', async () => {
    const conversation = [{ id: 3, sessionId: 27, role: 'assistant' as const, content: 'Existing answer', createdAt: 1 }]
    financeHistory.messages.value = conversation
    const { wrapper } = mountPanel(undefined, { workspaceKind: 'ledger' })
    await typeAndSend(wrapper, '/skills')
    await flushPromises()
    expect(getFinanceSkills).toHaveBeenCalledOnce()
    expect(getFinanceSkill).not.toHaveBeenCalled()
    expect(runLedgerAiCommand).not.toHaveBeenCalled()
    expect(financeHistory.sendAndStream).not.toHaveBeenCalled()
    expect(financeHistory.messages.value).toEqual(conversation)
    expect(document.body.textContent).toContain('Finance skills')
    expect(document.body.textContent).toContain('Monthly review')
  })

  it('uses only the send-time Note snapshot when the workspace changes during a stream', async () => {
    let current: AiLiveContextCapture = documentCapture('notes/a.md')
    const capture = vi.fn(() => current)
    let settle!: () => void
    const sendSpy = vi.spyOn(history, 'sendAndStream').mockImplementation(
      () => new Promise<void>((resolve) => { settle = resolve }),
    )
    const { wrapper, bridge } = mountPanel(capture, { workspaceKind: 'vault' })
    await nextTick()
    capture.mockClear()

    await typeAndSend(wrapper, 'captured from Note A')
    const sentSnapshot = sendSpy.mock.calls[0]?.[1]?.liveContext
    expect((sentSnapshot as AiDocumentContext).identity.path).toBe('notes/a.md')

    // Leaving Note immediately removes the live capture from the shell.
    bridge.value = null
    current = documentCapture('notes/b.md')
    await nextTick()
    settle()
    await nextTick()

    expect(capture).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0]?.[1]?.liveContext).toBe(sentSnapshot)
  })

  it('persists model selection independently per workspace and sends the selected profile', async () => {
    const storageKey = 'nuvyn.ai.model-profile:test-owner'
    localStorage.removeItem(`${storageKey}:vault`)
    localStorage.removeItem(`${storageKey}:diary`)
    const sendSpy = vi.spyOn(history, 'sendAndStream').mockImplementation(async () => {})
    const { wrapper } = mountPanel(undefined, {
      workspaceKind: 'vault',
      modelPreferenceStorageKey: storageKey,
    })
    await flushPromises()

    await wrapper.get('[data-testid="ai-model-selector"]').trigger('click')
    await wrapper.get('[data-testid="ai-model-option-profile-openai"]').trigger('click')
    expect(localStorage.getItem(`${storageKey}:vault`)).toBe('profile-openai')

    await wrapper.setProps({ workspaceKind: 'diary' })
    await nextTick()
    expect(wrapper.find('[data-testid="ai-coming-soon"]').exists()).toBe(true)
    expect(wrapper.findComponent(AiComposer).exists()).toBe(false)

    await wrapper.setProps({ workspaceKind: 'vault' })
    await nextTick()
    expect(wrapper.findComponent(AiComposer).props('selectedModelProfileId')).toBe('profile-openai')
    await typeAndSend(wrapper, 'use my selected model')
    expect(sendSpy).toHaveBeenCalledWith('use my selected model', {
      profileId: 'profile-openai',
      publishFileChange: expect.any(Function),
    })
    expect(localStorage.getItem(`${storageKey}:diary`)).toBeNull()
  })

  it('keeps the conversation mounted while hidden and restores the active history controls', async () => {
    const conversation = [{
      id: 5,
      sessionId: 2,
      role: 'assistant' as const,
      content: 'conversation retained',
      createdAt: 10,
    }]
    history.messages.value = conversation
    const wrapper = mount(AiPanel, {
      props: { open: true },
      global: { provide: { [AppShellContextKey as symbol]: { settingsRequestTick: ref(0) } } },
    })
    expect(wrapper.find('[data-testid="global-ai-panel"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="global-ai-new-session"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="global-ai-history"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="global-ai-close"]').exists()).toBe(true)

    await wrapper.setProps({ open: false })
    const panel = wrapper.find('[data-testid="global-ai-panel"]')
    expect(panel.exists()).toBe(true)
    expect((panel.element as HTMLElement).style.display).toBe('none')
    await wrapper.setProps({ open: true })
    expect(wrapper.findComponent(AiChatMessages).props('messages')).toEqual(conversation)
  })

  it('displays Note-specific prompts only with a live Note context', () => {
    const note = mountPanel(() => documentCapture(), { workspaceKind: 'vault' })
    const notePrompts = note.wrapper.findComponent(AiChatMessages).props('quickPrompts')
    expect(notePrompts[0]?.text).toBe(useI18n().t('quick_prompts.with_note.summarize.text'))

    const otherWorkspace = mountPanel(() => documentCapture(), { workspaceKind: 'ledger' })
    const genericPrompts = otherWorkspace.wrapper.findComponent(AiChatMessages).props('quickPrompts')
    expect(genericPrompts[0]?.text).toBe(useI18n().t('quick_prompts.ledger.review.text'))
    expect(otherWorkspace.wrapper.findComponent(AiChatMessages).props('currentPath')).toBeNull()
    expect(otherWorkspace.wrapper.findComponent(AiChatMessages).props('emptyHint')).toBe(useI18n().t('ai.empty_hint_ledger'))
  })

  it.each(['diary', 'board'] as const)('shows a clean coming soon state in %s without loading AI data', async (workspaceKind) => {
    const { wrapper } = mountPanel(undefined, { workspaceKind })
    await flushPromises()

    const panel = wrapper.get('[data-testid="global-ai-panel"]')
    expect(panel.find('.ai-floating-title').text()).toBe('AI assistant')
    expect(panel.find('[data-testid="ai-coming-soon"]').text()).toContain('Coming soon')
    expect(panel.find('[data-testid="ai-coming-soon"]').text()).toContain('AI features for this module are not available yet.')
    expect(panel.find('[data-testid="global-ai-close"]').exists()).toBe(true)
    expect(panel.find('[data-testid="global-ai-new-session"]').exists()).toBe(false)
    expect(panel.find('[data-testid="global-ai-history"]').exists()).toBe(false)
    expect(panel.find('.ai-no-key-banner').exists()).toBe(false)
    expect(panel.findComponent(AiChatMessages).exists()).toBe(false)
    expect(panel.findComponent(AiComposer).exists()).toBe(false)
    expect(panel.find('[data-testid="ai-finance-memory-dialog"]').exists()).toBe(false)
    expect(panel.find('[data-testid="ai-finance-skills-dialog"]').exists()).toBe(false)
    expect(getAiProfiles).not.toHaveBeenCalled()
    expect(history.loadActive).not.toHaveBeenCalled()
    expect(history.refreshModel).not.toHaveBeenCalled()
    expect(financeHistory.loadActive).not.toHaveBeenCalled()
    expect(history.createSession).not.toHaveBeenCalled()
    expect(history.sendAndStream).not.toHaveBeenCalled()
    expect(financeHistory.sendAndStream).not.toHaveBeenCalled()
    expect(getFinanceMemory).not.toHaveBeenCalled()
    expect(getFinanceSkills).not.toHaveBeenCalled()
  })

  it('keeps Note draft and conversation hidden but intact in Diary and Board', async () => {
    const conversation = [{ id: 44, sessionId: 12, role: 'assistant' as const, content: 'Note conversation stays private', createdAt: 1 }]
    history.messages.value = conversation
    const { wrapper } = mountPanel(undefined, { workspaceKind: 'vault' })
    await flushPromises()
    await wrapper.get('textarea').setValue('Note draft stays here')

    for (const workspaceKind of ['diary', 'board'] as const) {
      await wrapper.setProps({ workspaceKind })
      await nextTick()
      expect(wrapper.find('[data-testid="ai-coming-soon"]').exists()).toBe(true)
      expect(wrapper.findComponent(AiComposer).exists()).toBe(false)
      expect(wrapper.findComponent(AiChatMessages).exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Note conversation stays private')
      expect(history.messages.value).toEqual(conversation)
      expect(history.createSession).not.toHaveBeenCalled()
      expect(history.sendAndStream).not.toHaveBeenCalled()
    }

    await wrapper.setProps({ workspaceKind: 'vault' })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Note draft stays here')
    expect(wrapper.text()).toContain('Note conversation stays private')
    expect(history.messages.value).toEqual(conversation)
  })

  it('updates prompts with the available workspace while keeping Ledger state separate', async () => {
    history.messages.value = []
    const capture = vi.fn(() => documentCapture())
    const wrapper = mount(AiPanel, {
      props: { open: true, workspaceKind: 'vault' },
      global: { provide: { [AppShellContextKey as symbol]: { settingsRequestTick: ref(0), noteAiContext: ref({
        capture,
        publishFileChange: vi.fn(),
        linkPaths: () => [],
        openLink: vi.fn(async () => {}),
      }) } } },
    })

    await flushPromises()
    expect(capture).toHaveBeenCalled()
    capture.mockClear()
    await wrapper.setProps({ workspaceKind: 'ledger' })
    expect(wrapper.findComponent(AiChatMessages).props('quickPrompts').map(prompt => prompt.label)).toEqual([
      'Analyze this month’s cashflow', 'Analyze spending breakdown', 'Review financial trends',
    ])
    expect(wrapper.findComponent(AiChatMessages).props('currentPath')).toBeNull()
    expect(capture).not.toHaveBeenCalled()

    const prompt = wrapper.findAll('.ai-quick-prompt')[0]
    await prompt.trigger('click')
    expect(financeHistory.sendAndStream).toHaveBeenCalledExactlyOnceWith(
      useI18n().t('quick_prompts.ledger.review.text'), { profileId: 'profile-default', ledgerAnalysis: true },
    )
    expect(history.sendAndStream).not.toHaveBeenCalled()
    const expectedDraft = 'Finance draft'
    await wrapper.get('textarea').setValue(expectedDraft)

    const conversation = [{ id: 1, sessionId: 1, role: 'assistant' as const, content: 'kept', createdAt: 1 }]
    history.messages.value = conversation
    await wrapper.setProps({ workspaceKind: 'diary', diaryViewMode: 'events' })
    expect(wrapper.find('[data-testid="ai-coming-soon"]').exists()).toBe(true)
    expect(wrapper.findComponent(AiChatMessages).exists()).toBe(false)
    expect(wrapper.findComponent(AiComposer).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('kept')
    expect(history.messages.value).toEqual(conversation)
    await wrapper.setProps({ workspaceKind: 'ledger' })
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe(expectedDraft)
    expect(wrapper.findComponent(AiChatMessages).props('messages')).toEqual([])
  })

  it('ignores ordinary DOM changes and scans for external overlays only while open', async () => {
    const workspace = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.className = 'n-modal-mask'
    overlay.style.opacity = '0'
    vi.spyOn(overlay, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    document.body.append(workspace)
    const query = vi.spyOn(document, 'querySelectorAll')
    const overlayScans = () => query.mock.calls.filter(([selector]) => selector.includes('.n-modal-mask')).length
    const wrapper = mount(AiPanel, { props: { open: false } })
    const panel = wrapper.get('[data-testid="global-ai-panel"]')

    try {
      expect(overlayScans()).toBe(0)
      await wrapper.setProps({ open: true })
      expect(overlayScans()).toBe(1)

      const canvas = document.createElement('div')
      workspace.append(canvas)
      canvas.style.transform = 'translateX(4px)'
      canvas.className = 'dragging'
      await Promise.resolve()
      expect(overlayScans()).toBe(1)

      workspace.append(overlay)
      await nextTick()
      await nextTick()
      expect(overlayScans()).toBe(2)
      expect(panel.attributes('aria-hidden')).toBe('true')
      overlay.remove()
      await nextTick()
      await nextTick()
      expect(overlayScans()).toBe(3)
      expect(panel.attributes('aria-hidden')).toBeUndefined()

      await wrapper.setProps({ open: false })
      workspace.append(overlay)
      await nextTick()
      expect(overlayScans()).toBe(3)
    } finally {
      workspace.remove()
    }
  })
})
