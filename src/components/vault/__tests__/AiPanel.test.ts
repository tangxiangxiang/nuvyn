// @vitest-environment jsdom
import { defineComponent, h, nextTick, provide, ref, type Ref } from 'vue'
import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShellContextKey, type NoteAiContextBridge } from '../../../composables/appShellContext'
import type { AiLiveContextCapture, AiDocumentContext, AiLiveContextSnapshot } from '../../../composables/vault/aiLiveContext'
import { useAiHistory } from '../../../composables/vault/useAiHistory'
import { useI18n } from '../../../composables/useI18n'
import AiPanel from '../AiPanel.vue'
import AiChatMessages from '../AiChatMessages.vue'
import AiComposer from '../AiComposer.vue'

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
    ledgerApproval: vueRef(null),
    ledgerReading: vueRef(false),
    decideLedgerAnalysis: vi.fn(),
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
  return { useAiHistory: () => history }
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
enableAutoUnmount(afterEach)

describe('global AI panel', () => {
  beforeEach(() => {
    useI18n().setLocale('en')
    history.configured.value = true
    history.busy.value = false
    history.isLoading.value = false
    history.activeSession.value = null
    history.messages.value = []
    vi.clearAllMocks()
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
      liveContext: (capture as { status: 'ready'; context: AiLiveContextSnapshot }).context,
      publishFileChange: expect.any(Function),
    })
    expect(sendSpy.mock.calls[0]?.[1]).not.toHaveProperty('threadScope')
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe('')
  })

  it('sends ordinary AI messages without Note, Diary, Ledger, or Board context', async () => {
    const sendSpy = vi.spyOn(history, 'sendAndStream').mockImplementation(async () => {})
    const capture = vi.fn(() => documentCapture())
    const { wrapper } = mountPanel(capture, { workspaceKind: 'ledger' })
    await typeAndSend(wrapper, 'hello from another workspace')
    expect(sendSpy).toHaveBeenCalledWith('hello from another workspace', {})
    expect(capture).not.toHaveBeenCalled()
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

  it('updates prompts with the workspace and Diary view while preserving the draft and conversation', async () => {
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
    const expectedDraft = useI18n().t('quick_prompts.ledger.review.text')
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe(expectedDraft)
    expect(history.sendAndStream).not.toHaveBeenCalled()

    const conversation = [{ id: 1, sessionId: 1, role: 'assistant' as const, content: 'kept', createdAt: 1 }]
    history.messages.value = conversation
    await wrapper.setProps({ workspaceKind: 'diary', diaryViewMode: 'events' })
    expect(wrapper.findComponent(AiChatMessages).props('quickPrompts').map(prompt => prompt.label)).toEqual([
      'Plan an important date', 'Plan a birthday or anniversary', 'Plan an activity',
    ])
    expect(wrapper.findComponent(AiChatMessages).props('messages')).toEqual(conversation)
    expect(wrapper.findComponent(AiComposer).props('modelValue')).toBe(expectedDraft)
    expect(wrapper.findComponent(AiChatMessages).props('emptyHint')).toBe('I can help you plan important dates and activities.')
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
