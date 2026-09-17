// Wire types + typed fetch wrappers for /api/ai/*. The shapes
// (Session, Message) are the single source of truth — the server
// imports them via `from '../../src/lib/ai-api.js'` and the
// components import them from this file.
import type { AiLiveContextSnapshot } from '../composables/vault/aiLiveContext'
import { authFetch } from './auth-session'

export interface Session {
  id: number
  title: string
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: number
  sessionId: number
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  // When the assistant used tools, the server persists a JSON
  // envelope into `content`. After history load, the client may
  // rehydrate it into the structured shape for the panel to render
  // per-tool cards. The SSE stream does not set this — it streams
  // individual tool_use / tool_result events instead.
  blocks?: AssistantBlocks
}

// Structured representation of a tool-using assistant turn. Loaded
// from the JSON envelope in the DB content column. Kept loose
// (string-keyed) on purpose — the client doesn't need the full
// Anthropic content-block shape, just enough to render a tool card.
export interface AssistantBlocks {
  v: 1
  text: string
  toolCalls: ToolCallRecord[]
}

export interface ToolCallRecord {
  id: string
  name: string
  input: Record<string, unknown>
  result: { content: string; is_error: boolean }
}

export interface ActiveSession {
  activeId: number | null
  configured: boolean
  /** Full active session metadata when an active session exists. */
  activeSession?: Session | null
}

export interface AiSettings {
  provider: AiProvider
  configured: boolean
  source: 'db' | 'none'
  maskedKey: string
  baseURL: string
  model: string
}

export type AiProvider = 'anthropic' | 'openai'

export type AiKeyErrorCode =
  | 'master-key-required'
  | 'master-key-invalid'
  | 'master-key-file-unreadable'
  | 'master-key-file-unwritable'
  | 'stored-key-invalid'
  | 'openai-base-url-invalid'
  | 'openai-tools-unsupported'

export type AiConnectionErrorCode =
  | 'ai-connection-timeout'
  | 'ai-authentication-failed'
  | 'ai-model-unavailable'
  | 'ai-connection-failed'

export type AiApiErrorCode = AiKeyErrorCode | AiConnectionErrorCode

export type AiConnectionState = 'untested' | 'checking' | 'connected' | 'failed'

export interface AiConnectionTestResult {
  ok: true
  provider: AiProvider
  model: string
  checkedAt: number
  latencyMs: number
}

export interface AiApiErrorBody {
  error?: string
  code?: AiApiErrorCode
}

export type AiApiError = Error & {
  status: number
  body: AiApiErrorBody
  code?: AiApiErrorCode
}

export interface AiCredentialStatus {
  provider: AiProvider
  providers: Record<AiProvider, { stored: boolean }>
}

export interface ChatRequest {
  sessionId: number
  content: string
  // Edit-10.3: the ONE live-context authority on the new wire. When
  // present, it is the complete send-time snapshot captured by the
  // client at click time (src/composables/vault/aiLiveContext.ts).
  // The server validates it strictly and injects it into THIS run's
  // system prompt only — never persisted, never echoed over SSE.
  // When absent, the key is omitted from the JSON body entirely
  // (never null). Type-only import: the wire types stay free of any
  // runtime dependency on the capture module.
  liveContext?: AiLiveContextSnapshot
  /** Additional vault-relative documents selected with the composer + button. */
  contextPaths?: string[]
}

export type FileChangeKind = 'write' | 'delete' | 'rename'

export interface FileChangeEvent {
  path: string
  kind: FileChangeKind
  newMtime?: number
  newRaw?: string
  oldPath?: string
  source?: 'history-restore' | 'editor-save' | 'editor-lifecycle'
}

export type ChatEvent =
  | { type: 'user'; id: number }
  | { type: 'token'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'file_changed' } & FileChangeEvent
  | { type: 'done'; userId: number; assistantId: number }
  | { type: 'error'; reason: string; code?: AiKeyErrorCode; message?: string }

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    // The success path is strongly typed (Promise<T>); the failure path
    // reads `body.error` from whatever the server returned. We don't
    // have a schema for error bodies, so cast to the loose shape we
    // actually consume.
    const body = (await r.json().catch(() => ({ error: r.statusText }))) as AiApiErrorBody
    throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), {
      status: r.status,
      body,
      code: body.code,
    }) as AiApiError
  }
  return r.json() as Promise<T>
}

// Headers + body for a JSON request; the caller picks the method.
function jsonBody(body: unknown): RequestInit {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function listSessions(): Promise<Session[]> {
  return jsonOrThrow<Session[]>(await authFetch('/api/ai/sessions', { method: 'GET' }))
}

export async function createSession(): Promise<Session> {
  return jsonOrThrow<Session>(await authFetch('/api/ai/sessions', { method: 'POST' }))
}

export async function renameSession(id: number, title: string): Promise<Session> {
  return jsonOrThrow<Session>(await authFetch(`/api/ai/sessions/${id}`, { method: 'PATCH', ...jsonBody({ title }) }))
}

export async function deleteSession(id: number): Promise<{ ok: true }> {
  return jsonOrThrow<{ ok: true }>(await authFetch(`/api/ai/sessions/${id}`, { method: 'DELETE' }))
}

export async function listMessages(sessionId: number): Promise<Message[]> {
  return jsonOrThrow<Message[]>(await authFetch(`/api/ai/sessions/${sessionId}/messages`, { method: 'GET' }))
}

export async function appendMessage(
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
): Promise<Message> {
  return jsonOrThrow<Message>(await authFetch(`/api/ai/sessions/${sessionId}/messages`, { method: 'POST', ...jsonBody({ role, content }) }))
}

export async function getActiveSession(): Promise<ActiveSession> {
  return jsonOrThrow<ActiveSession>(await authFetch('/api/ai/active', { method: 'GET' }))
}

// Backwards-compat shim: existing call sites use getActiveSessionId()
// as a function returning number|null. The endpoint now returns
// { activeId, configured }; this shim extracts the id.
export async function getActiveSessionId(): Promise<number | null> {
  const out = await getActiveSession()
  return out.activeId
}

export async function setActiveSessionId(sessionId: number | null): Promise<number | null> {
  const r = await jsonOrThrow<{ sessionId: number | null }>(await authFetch('/api/ai/active', { method: 'PUT', ...jsonBody({ sessionId }) }))
  return r.sessionId
}

export async function getAiSettings(): Promise<AiSettings> {
  return jsonOrThrow<AiSettings>(await authFetch('/api/ai/settings', { method: 'GET' }))
}

export async function getAiCredentialStatus(): Promise<AiCredentialStatus> {
  return jsonOrThrow<AiCredentialStatus>(await authFetch('/api/ai/settings/credential-status', { method: 'GET' }))
}

export async function saveAiSettings(input: {
  provider?: 'anthropic' | 'openai'
  apiKey?: string
  baseURL?: string
  model?: string
}): Promise<AiSettings> {
  return jsonOrThrow<AiSettings>(await authFetch('/api/ai/settings', {
    method: 'PUT',
    ...jsonBody(input),
  }))
}

export async function clearAiApiKey(provider?: AiProvider): Promise<{ cleared: true; provider: AiProvider }> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''
  return jsonOrThrow<{ cleared: true; provider: AiProvider }>(await authFetch(`/api/ai/settings/key${query}`, { method: 'DELETE' }))
}

export async function testAiConnection(
  input: {
    provider: AiProvider
    apiKey?: string
    baseURL: string
    model: string
  },
  signal?: AbortSignal,
): Promise<AiConnectionTestResult> {
  return jsonOrThrow<AiConnectionTestResult>(await authFetch('/api/ai/settings/test-connection', {
    method: 'POST',
    ...jsonBody(input),
    signal,
  }))
}

export async function suggestSlug(input: {
  input: string
  kind: 'file' | 'folder'
}): Promise<{ slug: string }> {
  return jsonOrThrow<{ slug: string }>(await authFetch('/api/ai/slug', {
    method: 'POST',
    ...jsonBody(input),
  }))
}

export async function suggestCommitMessage(input: {
  paths: string[]
  selectedPath?: string
  diffText?: string
  language?: 'zh' | 'en'
}, signal?: AbortSignal): Promise<{ message: string }> {
  return jsonOrThrow<{ message: string }>(await authFetch('/api/ai/commit-message', {
    method: 'POST',
    ...jsonBody(input),
    signal,
  }))
}

export async function suggestSummary(input: {
  path: string
  content?: string
  language?: 'zh' | 'en'
  documentId?: string
}, signal?: AbortSignal): Promise<{ summary: string }> {
  return jsonOrThrow<{ summary: string }>(await authFetch('/api/ai/summary', {
    method: 'POST',
    ...jsonBody(input),
    signal,
  }))
}

/**
 * Open a streaming chat request and yield typed ChatEvent objects.
 * Yields exactly one {type: 'error'} event and returns on any HTTP
 * failure (the body parser short-circuits the stream).
 */
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await authFetch('/api/ai/chat', {
    method: 'POST',
    ...jsonBody(req),
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ reason: `http-${res.status}` })) as {
      reason?: string
      code?: AiKeyErrorCode
      message?: string
    }
    yield {
      type: 'error',
      reason: body.reason ?? `http-${res.status}`,
      ...(body.code ? { code: body.code } : {}),
      ...(body.message ? { message: body.message } : {}),
    }
    return
  }
  if (!res.body) {
    yield { type: 'error', reason: 'no-body' }
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const eventLine = block.match(/^event:\s*(.+)$/m)
      const dataLine = block.match(/^data:\s*(.+)$/m)
      if (!eventLine || !dataLine) continue
      try {
        const parsed = JSON.parse(dataLine[1])
        yield { type: eventLine[1].trim(), ...parsed } as ChatEvent
      } catch {
        // Ignore malformed blocks — the test will assert what we expect.
      }
    }
  }
}
