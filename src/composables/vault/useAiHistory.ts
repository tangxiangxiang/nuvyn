// AI history state + actions. Each VaultContext owns the instance shared by
// AiPanel, the session picker, and settings. Persistence is server-side; this
// composable is just a
// thin read-through cache + the action helpers that drive it.
//
// sendMessage auto-creates a session if none is active. The
// optimistic update is replaced by the server response on success
// — the temp id is 0, which the rendering layer can use to
// distinguish "pending" from "saved" if needed, but for now the
// messages list re-renders cleanly on the swap.
//
// sendAndStream is the streaming equivalent of sendMessage. It
// uses the same optimistic-update pattern but iterates the SSE
// event stream from /api/ai/chat, appending tokens to the
// assistant message in place. Tool events (`tool_use` /
// `tool_result`) accumulate into the assistant message's
// `blocks.toolCalls` so the panel can render a per-tool card.
// `file_changed` events are forwarded to the file-change bus so
// the editor can refresh any open tab.
import { ref, type Ref } from 'vue'
import * as api from '../../lib/ai-api.js'
import type { Session, Message, ChatEvent, ToolCallRecord, AiProvider, AiThreadScope } from '../../lib/ai-api.js'
import { streamChat } from '../../lib/ai-api.js'
import type { FileChangeEvent } from '../../lib/ai-api.js'
import type { AiLiveContextSnapshot } from './aiLiveContext.js'
import { getFallbackVaultFileChanges } from './context/fileChanges.js'
import { useOptionalVaultContext } from './context/useVaultContext.js'
import type { VaultContext } from './context/types.js'

// Edit-10.3: options for sendAndStream. `liveContext` is the
// caller's send-time snapshot (captured BEFORE any await at the call
// site, e.g. AiPanel.onSend). It is forwarded verbatim as the
// request's liveContext field — never re-read, mutated, persisted,
// or added to message state here.
export interface SendAndStreamOptions {
  liveContext?: AiLiveContextSnapshot
  threadScope?: AiThreadScope
}

export interface AiHistory {
  // state
  activeSession: Ref<Session | null>
  messages: Ref<Message[]>
  threadScope: Ref<AiThreadScope | null>
  sessions: Ref<Session[]>
  isLoading: Ref<boolean>
  busy: Ref<boolean>
  errorState: Ref<string | null>
  configured: Ref<boolean>
  model: Ref<string>

  // actions
  loadActive(): Promise<void>
  loadSettings(): Promise<void>
  loadThread(scope: AiThreadScope | null): Promise<void>
  clearThread(scope: AiThreadScope): Promise<void>
  refreshModel(): Promise<void>
  refreshSessions(): Promise<void>
  createSession(): Promise<Session>
  switchSession(id: number): Promise<void>
  renameSession(id: number, title: string): Promise<void>
  deleteSession(id: number): Promise<void>
  sendMessage(content: string): Promise<void>
  sendAndStream(text: string, options?: SendAndStreamOptions): Promise<void>
  // Cancel the in-flight stream. No-op when nothing is running.
  // The AbortController lives in sendAndStream's closure so the
  // composable's public interface doesn't have to expose the
  // controller itself; stop() is the only handle the UI needs.
  stop(): void
}

let stateByVault = new WeakMap<VaultContext, AiHistory>()
let legacyState: AiHistory | null = null

const DEFAULT_MODEL_BY_PROVIDER: Record<AiProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
}

// Test-only escape hatch: reset the fallback and scoped cache so each test starts
// from a clean slate. Not exported in the public type — tests reach
// for it via a re-export declared in __tests__.
export function __resetForTesting(): void {
  legacyState = null
  stateByVault = new WeakMap()
}

function createAiHistory(publishChange: (event: FileChangeEvent) => void): AiHistory {
  // The currently in-flight stream belongs only to this Vault instance.
  let activeController: AbortController | null = null
  let streamSettled: Promise<void> = Promise.resolve()
  let settleStream: (() => void) | null = null
  let threadLoadGeneration = 0

  const activeSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const threadScope = ref<AiThreadScope | null>(null)
  const sessions = ref<Session[]>([])
  const isLoading = ref(false)
  const busy = ref(false)
  const errorState = ref<string | null>(null)
  const configured = ref(false)
  const model = ref('')

  async function loadActive() {
    isLoading.value = true
    try {
      threadScope.value = null
      const out = await api.getActiveSession()
      configured.value = out.configured
      model.value = out.model ?? ''
      if (out.activeId === null) {
        activeSession.value = null
        messages.value = []
        return
      }
      activeSession.value = out.activeSession?.id === out.activeId
        ? out.activeSession
        : { id: out.activeId, title: '', createdAt: 0, updatedAt: 0 }
      messages.value = await api.listMessages(out.activeId)
    } finally {
      isLoading.value = false
    }
  }

  async function loadSettings() {
    const out = await api.getActiveSession()
    configured.value = out.configured
    model.value = out.model ?? ''
  }

  async function loadThread(scope: AiThreadScope | null) {
    const generation = ++threadLoadGeneration
    if (busy.value) {
      stop()
      await streamSettled
    }
    if (generation !== threadLoadGeneration) return

    threadScope.value = scope
    activeSession.value = null
    messages.value = []
    errorState.value = null
    isLoading.value = true
    try {
      const [status, thread] = await Promise.all([
        api.getActiveSession(),
        scope ? api.getAiThread(scope) : Promise.resolve(null),
      ])
      if (generation !== threadLoadGeneration) return
      configured.value = status.configured
      model.value = status.model ?? ''
      activeSession.value = thread?.session ?? null
      messages.value = thread?.messages ?? []
    } finally {
      if (generation === threadLoadGeneration) isLoading.value = false
    }
  }

  async function clearThread(scope: AiThreadScope) {
    if (busy.value) {
      stop()
      await streamSettled
    }
    await api.clearAiThread(scope)
    if (threadScope.value && threadScopeKey(threadScope.value) === threadScopeKey(scope)) {
      activeSession.value = null
      messages.value = []
    }
  }

  async function refreshModel() {
    const settings = await api.getAiSettings()
    model.value = settings.model || DEFAULT_MODEL_BY_PROVIDER[settings.provider]
  }

  function threadScopeKey(scope: AiThreadScope): string {
    const identity = scope.kind === 'document'
      ? scope.documentId
      : ''
    return JSON.stringify([scope.kind, scope.vaultId, identity])
  }

  async function refreshSessions() {
    const nextSessions = await api.listSessions()
    if (!Array.isArray(nextSessions)) return
    sessions.value = nextSessions
    const activeId = activeSession.value?.id
    if (activeId === undefined) return
    const refreshedActive = nextSessions.find((session) => session.id === activeId)
    if (refreshedActive) activeSession.value = refreshedActive
  }

  async function createSession(): Promise<Session> {
    const s = await api.createSession()
    activeSession.value = s
    messages.value = []
    await api.setActiveSessionId(s.id)
    return s
  }

  async function switchSession(id: number) {
    isLoading.value = true
    try {
      await api.setActiveSessionId(id)
      activeSession.value = { id, title: '', createdAt: 0, updatedAt: 0 }
      messages.value = await api.listMessages(id)
    } finally {
      isLoading.value = false
    }
  }

  async function renameSession(id: number, title: string) {
    const updated = await api.renameSession(id, title)
    if (activeSession.value?.id === id) activeSession.value = updated
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx >= 0) sessions.value[idx] = updated
  }

  async function deleteSession(id: number) {
    await api.deleteSession(id)
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSession.value?.id === id) {
      activeSession.value = null
      messages.value = []
    }
  }

  async function sendMessage(content: string) {
    return sendAndStream(content)
  }

  async function sendAndStream(
    text: string,
    options?: SendAndStreamOptions,
  ): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!configured.value) return
    if (busy.value || isLoading.value) return

    if (options?.threadScope) {
      const loadedKey = threadScope.value ? threadScopeKey(threadScope.value) : null
      if (loadedKey !== threadScopeKey(options.threadScope)) {
        await loadThread(options.threadScope)
      }
    }
    if (busy.value || isLoading.value) return

    busy.value = true
    errorState.value = null
    const ac = new AbortController()
    activeController = ac
    streamSettled = new Promise<void>((resolve) => { settleStream = resolve })
    let optimisticAssistant: Message | null = null

    try {
      let session = activeSession.value
      if (options?.threadScope) {
        session = await api.ensureAiThread(options.threadScope)
        if (ac.signal.aborted) return
        activeSession.value = session
        threadScope.value = options.threadScope
      } else if (!session) {
        session = await createSession()
      }
      if (!session) throw new Error('AI thread is unavailable')
      const sessionId = session.id

      // Optimistic insert: user message (id 0) + empty assistant (id 0).
      // Object identity is the in-flight discriminator (see spec §3.9).
      const userMessage: Message = {
        id: 0,
        sessionId,
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      }
      const assistantMessage: Message = {
        id: 0,
        sessionId,
        role: 'assistant',
        content: '',
        createdAt: Date.now() + 1,
        blocks: { v: 1, text: '', toolCalls: [] },
      }
      optimisticAssistant = assistantMessage
      messages.value = [...messages.value, userMessage, assistantMessage]

      for await (const event of streamChat(
        {
          sessionId,
          content: trimmed,
          ...(options?.threadScope ? { threadScope: options.threadScope } : {}),
          // Edit-10.3: the send-time snapshot is the ONE live-context
          // authority. Present → it becomes the request's liveContext
          // field (server injects it into this run's system prompt
          // only). Absent → the key is omitted from the JSON body
          // entirely: never null, never a legacy path fallback.
          ...(options?.liveContext ? { liveContext: options.liveContext } : {}),
        },
        ac.signal,
      )) {
        applyEvent(event, userMessage, assistantMessage)
        if (event.type === 'done' || event.type === 'error') break
      }
      if (!options?.threadScope) await refreshSessions()
    } catch (e) {
      // Abort is the expected path when the user clicks Stop; surface
      // it as a quiet "[aborted]" tag on the assistant bubble and
      // move on. Other errors are rethrown so the existing
      // finally (which clears busy) still runs, but the catch
      // block doesn't swallow them silently.
      if (ac.signal.aborted && optimisticAssistant) {
        optimisticAssistant.content += '\n\n[aborted]'
        if (optimisticAssistant.blocks) {
          optimisticAssistant.blocks.text = optimisticAssistant.content
        }
        messages.value = messages.value.map((m) =>
          m === optimisticAssistant
            ? { ...m, id: -1, content: optimisticAssistant.content, blocks: optimisticAssistant.blocks }
            : m,
        )
        optimisticAssistant.id = -1
      } else {
        throw e
      }
    } finally {
      activeController = null
      busy.value = false
      settleStream?.()
      settleStream = null
    }
  }

  function stop(): void {
    // Just trigger the signal; the catch above handles the
    // visible side-effect. No busy-flag manipulation here —
    // that's the for-await's finally's job.
    activeController?.abort()
  }

  function applyEvent(
    event: ChatEvent,
    optimisticUser: Message,
    optimisticAssistant: Message,
  ): void {
    if (event.type === 'user') {
      messages.value = messages.value.map((m) =>
        m === optimisticUser ? { ...m, id: event.id } : m
      )
      optimisticUser.id = event.id
    } else if (event.type === 'token') {
      optimisticAssistant.content += event.text
      if (optimisticAssistant.blocks) {
        optimisticAssistant.blocks.text = optimisticAssistant.content
      }
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant
          ? { ...m, content: optimisticAssistant.content, blocks: optimisticAssistant.blocks }
          : m,
      )
    } else if (event.type === 'tool_use') {
      if (!optimisticAssistant.blocks) {
        optimisticAssistant.blocks = { v: 1, text: optimisticAssistant.content, toolCalls: [] }
      }
      const tc: ToolCallRecord = {
        id: event.id,
        name: event.name,
        input: event.input,
        result: { content: '', is_error: false },
      }
      optimisticAssistant.blocks.toolCalls.push(tc)
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant ? { ...m, blocks: optimisticAssistant.blocks } : m,
      )
    } else if (event.type === 'tool_result') {
      if (optimisticAssistant.blocks) {
        const tc = optimisticAssistant.blocks.toolCalls.find((t) => t.id === event.tool_use_id)
        if (tc) {
          tc.result = { content: event.content, is_error: event.is_error }
          messages.value = messages.value.map((m) =>
            m === optimisticAssistant ? { ...m, blocks: optimisticAssistant.blocks } : m,
          )
        }
      }
    } else if (event.type === 'file_changed') {
      // Forward to the file-change bus so the editor can refresh
      // any open tab. We don't mutate the message — the tool card
      // already shows what the AI did.
      publishChange({
        path: event.path,
        kind: event.kind,
        newMtime: event.newMtime,
        newRaw: event.newRaw,
        oldPath: event.oldPath,
      })
    } else if (event.type === 'done') {
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant ? { ...m, id: event.assistantId } : m,
      )
      optimisticAssistant.id = event.assistantId
    } else if (event.type === 'error') {
      optimisticAssistant.content += `\n\n[error: ${event.reason}]${event.message ? ` ${event.message}` : ''}`
      if (optimisticAssistant.blocks) {
        optimisticAssistant.blocks.text = optimisticAssistant.content
      }
      messages.value = messages.value.map((m) =>
        m === optimisticAssistant
          ? { ...m, id: -1, content: optimisticAssistant.content, blocks: optimisticAssistant.blocks }
          : m,
      )
      optimisticAssistant.id = -1
      errorState.value = event.reason
    }
  }

  return {
    activeSession,
    messages,
    threadScope,
    sessions,
    isLoading,
    busy,
    errorState,
    configured,
    model,
    loadActive,
    loadSettings,
    loadThread,
    clearThread,
    refreshModel,
    refreshSessions,
    createSession,
    switchSession,
    renameSession,
    deleteSession,
    sendMessage,
    sendAndStream,
    stop,
  }
}

export function useAiHistory(): AiHistory {
  const vaultContext = useOptionalVaultContext()
  if (!vaultContext) {
    legacyState ??= createAiHistory(getFallbackVaultFileChanges().publish)
    return legacyState
  }

  let state = stateByVault.get(vaultContext)
  if (!state) {
    state = createAiHistory(vaultContext.fileChanges.publish)
    stateByVault.set(vaultContext, state)
    vaultContext.onDispose(state.stop)
  }
  return state
}
