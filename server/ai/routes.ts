// Hono sub-router for /api/ai. The handlers are intentionally thin:
// parse the request, call the matching service function, translate
// the service result to an HTTP status + JSON body.
//
// Two non-obvious choices:
//   - getDb() is called at request time, not at module load. This
//     keeps the import side-effect-free (server/index.ts can mount
//     this sub-app without creating ./data/nuvyn.db at startup) and
//     lets tests spy on getDb to inject an in-memory DB.
//   - The bad() helper is duplicated here rather than imported from
//     ../index.js to avoid creating a circular import (index.js
//     will eventually import this file). The signature is identical
//     to the helper in ../index.ts.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import matter from 'gray-matter'
import { getDb } from '../db.js'
import { getAuthRuntime } from '../auth/runtime.js'
import {
  CONTENT_DIR,
  isValidPathSyntax,
  readSafeRelativeFile,
  resolveSafeRelativePath,
  SafePathResourceLimitError,
  normalizeLogicalContentPath,
} from '../paths.js'
import * as historyGit from '../history/git.js'
import { computeFileDiff } from '../history/diff.js'
import { validateHistoryPaths } from '../history/validation.js'
import * as sessions from './sessions.js'
import * as messages from './messages.js'
import { runChat, type ChatContext, type ChatEvent } from './chat.js'
import { parseAiLiveContext } from './live-context.js'
import { generateSlug } from './slug.js'
import { CommitMessagePromptLimitError, generateCommitMessage } from './commitMessage.js'
import { generateSummary, SummaryPromptLimitError } from './summary.js'
import { ChatError } from './errors.js'
import { hasDiaryBodyAccess, requireDiaryBodyAccess } from '../diaryAccess/guard.js'
import { readDiaryAccessCapability } from '../diaryAccess/service.js'
import { classifyDiaryPath } from '../../shared/diaryProtocol.js'
import {
  AiConnectionError,
  probeAiConnection,
  resolveAiRuntimeConfig,
} from './llm.js'
import {
  AiKeyConfigurationError,
  AiSettingsValidationError,
  clearAiApiKey,
  getAiCredentialStatus,
  getAiSettingsView,
  MAX_AI_API_KEY_LENGTH,
  MAX_AI_BASE_URL_LENGTH,
  MAX_AI_MODEL_LENGTH,
  normalizeOpenAiBaseURL,
  readStoredAiSettingsReadOnly,
  saveAiSettings,
  SUPPORTED_PROVIDERS,
  type Provider,
} from './settings.js'
import type { Message, AssistantBlocks } from '../../src/lib/ai-api.js'

function bad(c: any, msg: string, status = 400, errorCode?: string) {
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: msg,
    ...(errorCode ? { code: errorCode } : {}),
  }, status)
}

// Provider SDK errors are useful for diagnosing an OpenAI-compatible
// endpoint, but never echo a configured secret back to the browser. Keep
// the diagnostic bounded so a proxy's verbose error cannot turn into an
// unbounded SSE frame.
function safeProviderMessage(message: string, apiKey?: string): string {
  const redacted = apiKey ? message.split(apiKey).join('[redacted]') : message
  return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}…` : redacted
}

function aiKeyErrorResponse(c: any, error: unknown) {
  if (error instanceof AiKeyConfigurationError
    || (error instanceof ChatError && error.reason === 'key-error')) {
    return bad(c, (error as Error).message, 503, (error as AiKeyConfigurationError | ChatError).code)
  }
  return null
}

function aiSettingsValidationResponse(c: any, error: unknown) {
  if (error instanceof AiSettingsValidationError) {
    return bad(c, error.message, 400, error.code)
  }
  return null
}

function isValidHttpUrl(value: string): boolean {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/* Model name allowlist. Permissive enough for the common naming
   conventions across providers:
     - alphanumerics, dot, underscore, hyphen, colon: standard
     - slash: provider/model paths (e.g. `anthropic/claude-3`)
     - brackets: version tags in some providers
       (e.g. `MiniMax-M3[1m]`, legacy `gpt-4-0314`-style tags)
   Explicitly rejected: whitespace, quotes, semicolons, angle
   brackets, backticks — anything that could be misused as a shell
   metacharacter or break CLI quoting. The check is character-class
   rather than deny-list so a new provider's naming convention
   doesn't get blocked by a missing exception. */
function isValidModelName(value: string): boolean {
  if (!value) return true
  return /^[A-Za-z0-9._:/[\]-]+$/.test(value)
}

export const MAX_COMMIT_MESSAGE_PATHS = 20
export const MAX_AI_DIFF_FILE_BYTES = 256 * 1024
export const MAX_AI_DIFF_TOTAL_BYTES = 1024 * 1024
export const MAX_AI_DIFF_LINES = 10_000
export const MAX_COMMIT_DIFF_CHARS = 8_000
export const MAX_TOTAL_COMMIT_DIFF_CHARS = 20_000
export const MAX_SUMMARY_FILE_BYTES = 24 * 1024
export const MAX_SUMMARY_CONTENT_CHARS = 20_000
export const MAX_CHAT_CONTEXT_PATHS = 12

class CommitMessageResourceLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommitMessageResourceLimitError'
  }
}

type CommitChange = {
  path: string
  changeKind: 'added' | 'modified' | 'deleted'
  diff: string
}

function formatCommitDiff(before: string | null, after: string | null, filePath: string): string {
  const diff = computeFileDiff(before, after)
  const lines: string[] = []
  let outputLength = 0
  for (const op of diff.ops) {
    const prefix = op.op === 'add' ? '+' : op.op === 'remove' ? '-' : ' '
    const next = `${prefix}${op.text}`
    const nextLength = outputLength + (lines.length === 0 ? 0 : 1) + next.length
    if (nextLength > MAX_COMMIT_DIFF_CHARS) {
      throw new CommitMessageResourceLimitError(
        `AI diff exceeds the per-file prompt limit: ${filePath}`,
      )
    }
    lines.push(next)
    outputLength = nextLength
  }
  return lines.join('\n')
}

async function collectCommitChanges(
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<CommitChange[]> {
  const changes: CommitChange[] = []
  let totalBytes = 0
  let totalLines = 0
  let totalDiffChars = 0
  for (const filePath of paths) {
    if (signal?.aborted) throw new ChatError('aborted')
    const [before, after] = await Promise.all([
      historyGit.rawAt(CONTENT_DIR, 'HEAD', filePath, { maxBytes: MAX_AI_DIFF_FILE_BYTES, signal }),
      historyGit.rawAt(CONTENT_DIR, historyGit.WORKTREE_REF, filePath, { maxBytes: MAX_AI_DIFF_FILE_BYTES, signal }),
    ])
    const beforeBytes = before === null ? 0 : Buffer.byteLength(before, 'utf8')
    const afterBytes = after === null ? 0 : Buffer.byteLength(after, 'utf8')
    totalBytes += beforeBytes + afterBytes
    if (totalBytes > MAX_AI_DIFF_TOTAL_BYTES) {
      throw new CommitMessageResourceLimitError('AI diff exceeds the total input byte limit')
    }
    const beforeLines = before === null || before.length === 0 ? 0 : before.split(/\r?\n/).length
    const afterLines = after === null || after.length === 0 ? 0 : after.split(/\r?\n/).length
    totalLines += beforeLines + afterLines
    if (totalLines > MAX_AI_DIFF_LINES) {
      throw new CommitMessageResourceLimitError('AI diff exceeds the total line limit')
    }
    const changeKind = before === null
      ? 'added'
      : after === null
        ? 'deleted'
        : 'modified'
    const diff = formatCommitDiff(before, after, filePath)
    totalDiffChars += diff.length
    if (totalDiffChars > MAX_TOTAL_COMMIT_DIFF_CHARS) {
      throw new CommitMessageResourceLimitError('AI diff exceeds the total prompt limit')
    }
    changes.push({
      path: filePath,
      changeKind,
      diff,
    })
  }
  return changes
}

// Edit-10.3: old clients still send the path-only hint. Its
// validation stays deliberately lenient (a bad hint degrades to
// { kind: 'none' }, never to a 4xx — old clients must keep working);
// the strict door is parseAiLiveContext for the live snapshot.
function isValidLegacyNotePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes(String.fromCharCode(0)) &&
    !/[\r\n]/.test(value)
  )
}

function parseChatContextPaths(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CHAT_CONTEXT_PATHS) return null
  const paths: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const normalized = normalizeLogicalContentPath(item)
    if (!normalized || paths.includes(normalized)) return null
    paths.push(normalized)
  }
  return paths
}

// Tool-using assistant turns persist as a JSON envelope in the
// `content` column (see server/ai/chat.ts). On the wire, the client
// expects the same shape the streaming code path produces in
// memory: plain text in `content` and the structured envelope
// (minus the server-internal `rounds` field) in `blocks`. The
// storage layer keeps the raw envelope so buildConvoFromHistory
// can still rebuild the SDK convo including `rounds`; this
// transform is a presentation concern, so it lives in the API
// layer, not the storage layer.
function rehydrateForClient(m: Message): Message {
  if (m.role !== 'assistant') return m
  const parsed = messages.parseStoredContent(m.content)
  if (parsed.kind !== 'envelope') return m
  const blocks: AssistantBlocks = {
    v: 1,
    text: parsed.envelope.text,
    toolCalls: parsed.envelope.toolCalls,
  }
  return { ...m, content: parsed.envelope.text, blocks }
}

const ai = new Hono()

// ---- /sessions ----
ai.get('/sessions', (c) => c.json(sessions.listSessions(getDb())))

ai.post('/sessions', (c) => {
  const s = sessions.createSession(getDb())
  return c.json(s, 201)
})

ai.patch('/sessions/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const body = c.req.json().catch(() => null) as Promise<{ title?: unknown } | null>
  return body.then((b) => {
    if (!b || typeof b.title !== 'string') return bad(c, 'title required')
    if (b.title.trim().length === 0) return bad(c, 'title must not be empty')
    const updated = sessions.renameSession(getDb(), id, b.title)
    if (!updated) return bad(c, 'not found', 404)
    return c.json(updated)
  })
})

ai.delete('/sessions/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const ok = sessions.deleteSession(getDb(), id)
  if (!ok) return bad(c, 'not found', 404)
  return c.json({ ok: true })
})

// ---- /sessions/:id/messages ----
ai.get('/sessions/:id/messages', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const list = messages.listMessages(getDb(), id)
  if (list === null) return bad(c, 'not found', 404)
  return c.json(list.map(rehydrateForClient))
})

ai.post('/sessions/:id/messages', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return bad(c, 'invalid id')
  const body = await c.req.json().catch(() => null) as { role?: unknown; content?: unknown } | null
  if (!body || typeof body.role !== 'string' || typeof body.content !== 'string') {
    return bad(c, 'role and content required')
  }
  const result = messages.appendMessage(getDb(), id, body.role as 'user' | 'assistant', body.content)
  if (result.ok) return c.json(result.message, 201)
  if (result.reason === 'not-found') return bad(c, 'not found', 404)
  return bad(c, result.reason) // 'empty' or 'invalid-role' → 400
})

// ---- /settings ----
ai.get('/settings', (c) => {
  try {
    return c.json(getAiSettingsView(getDb()))
  } catch (error) {
    const response = aiKeyErrorResponse(c, error)
    if (response) return response
    throw error
  }
})

/**
 * Probe the exact provider configuration currently shown by Settings. This
 * route is intentionally transient: an unsaved key/base URL/model is passed
 * straight to the provider and no settings row is written.
 */
ai.post('/settings/test-connection', async (c) => {
  const body = await c.req.json().catch(() => null) as
    | { provider?: unknown; apiKey?: unknown; baseURL?: unknown; model?: unknown }
    | null
  if (!body) return bad(c, 'body required')
  if (typeof body.provider !== 'string' || !(SUPPORTED_PROVIDERS as readonly string[]).includes(body.provider)) {
    return bad(c, `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`)
  }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') return bad(c, 'apiKey must be a string')
  if (body.baseURL !== undefined && typeof body.baseURL !== 'string') return bad(c, 'baseURL must be a string')
  if (body.model !== undefined && typeof body.model !== 'string') return bad(c, 'model must be a string')

  const provider = body.provider as Provider
  const requestedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const requestedBaseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : undefined
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : undefined
  if (requestedKey.length > MAX_AI_API_KEY_LENGTH) return bad(c, 'apiKey is too long')
  if (requestedBaseURL && requestedBaseURL.length > MAX_AI_BASE_URL_LENGTH) return bad(c, 'baseURL is too long')
  if (requestedModel && requestedModel.length > MAX_AI_MODEL_LENGTH) return bad(c, 'model is too long')
  if (requestedBaseURL && !isValidHttpUrl(requestedBaseURL)) return bad(c, 'baseURL must be an http(s) URL')
  if (requestedModel && !isValidModelName(requestedModel)) return bad(c, 'model contains unsupported characters')

  let stored: ReturnType<typeof readStoredAiSettingsReadOnly>
  try {
    stored = readStoredAiSettingsReadOnly(getDb())
  } catch (error) {
    const validation = aiSettingsValidationResponse(c, error)
    if (validation) return validation
    const response = aiKeyErrorResponse(c, error)
    if (response) return response
    throw error
  }
  const saved = stored[provider]
  const apiKey = requestedKey || saved.apiKey
  if (!apiKey) return bad(c, 'AI API key is not configured', 503, 'ai-authentication-failed')
  let baseURL = requestedBaseURL === undefined ? saved.baseURL : requestedBaseURL
  if (provider === 'openai' && baseURL) {
    try {
      baseURL = normalizeOpenAiBaseURL(baseURL)
    } catch (error) {
      const validation = aiSettingsValidationResponse(c, error)
      if (validation) return validation
      throw error
    }
  }
  const model = requestedModel || saved.model
  const startedAt = Date.now()
  try {
    await probeAiConnection({
      provider,
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      model,
    }, c.req.raw.signal)
    return c.json({
      ok: true,
      provider,
      model,
      checkedAt: Date.now(),
      latencyMs: Math.max(0, Date.now() - startedAt),
    })
  } catch (error) {
    if (error instanceof AiConnectionError) {
      const status = error.code === 'ai-authentication-failed' ? 401
        : error.code === 'ai-model-unavailable' ? 502
          : error.code === 'ai-connection-timeout' ? 504
            : 502
      return bad(c, safeProviderMessage(error.message, apiKey), status, error.code)
    }
    const response = aiKeyErrorResponse(c, error)
    if (response) return response
    throw error
  }
})

ai.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => null) as
    | { provider?: unknown; apiKey?: unknown; baseURL?: unknown; model?: unknown }
    | null
  if (!body) return bad(c, 'body required')
  if (body.provider !== undefined && typeof body.provider !== 'string') return bad(c, 'provider must be a string')
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') return bad(c, 'apiKey must be a string')
  if (body.baseURL !== undefined && typeof body.baseURL !== 'string') return bad(c, 'baseURL must be a string')
  if (body.model !== undefined && typeof body.model !== 'string') return bad(c, 'model must be a string')
  let provider: Provider | undefined
  if (body.provider !== undefined) {
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(body.provider)) {
      return bad(c, `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`)
    }
    provider = body.provider as Provider
  }
  const apiKey = body.apiKey?.trim()
  const baseURL = body.baseURL?.trim()
  const model = body.model?.trim()
  if (apiKey && apiKey.length > MAX_AI_API_KEY_LENGTH) return bad(c, 'apiKey is too long')
  if (baseURL && baseURL.length > MAX_AI_BASE_URL_LENGTH) return bad(c, 'baseURL is too long')
  if (model && model.length > MAX_AI_MODEL_LENGTH) return bad(c, 'model is too long')
  if (baseURL && !isValidHttpUrl(baseURL)) return bad(c, 'baseURL must be an http(s) URL')
  if (model && !isValidModelName(model)) return bad(c, 'model contains unsupported characters')
  try {
    saveAiSettings(getDb(), { provider, apiKey, baseURL, model })
    return c.json(getAiSettingsView(getDb()))
  } catch (error) {
    const validation = aiSettingsValidationResponse(c, error)
    if (validation) return validation
    const response = aiKeyErrorResponse(c, error)
    if (response) return response
    throw error
  }
})

ai.delete('/settings/key', (c) => {
  const requested = c.req.query('provider')
  if (requested !== undefined && !(SUPPORTED_PROVIDERS as readonly string[]).includes(requested)) {
    return bad(c, `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`)
  }
  return c.json(clearAiApiKey(getDb(), requested as Provider | undefined))
})

// This endpoint intentionally inspects only whether rows are non-empty. It
// never decrypts credentials and is used solely to render explicit recovery
// actions when /settings cannot be read.
ai.get('/settings/credential-status', (c) => c.json(getAiCredentialStatus(getDb())))

// ---- /active ----
ai.get('/active', (c) => {
  const db = getDb()
  const storedActiveId = sessions.getActiveSessionId(db)
  const activeSession = storedActiveId === null ? null : sessions.getSession(db, storedActiveId)
  let configured: boolean
  try {
    configured = Boolean(resolveAiRuntimeConfig(db).apiKey)
  } catch (error) {
    const response = aiKeyErrorResponse(c, error)
    if (response) return response
    throw error
  }
  return c.json({
    activeId: activeSession?.id ?? null,
    activeSession,
    configured,
  })
})

ai.put('/active', async (c) => {
  const body = await c.req.json().catch(() => null) as { sessionId?: unknown } | null
  if (!body || (body.sessionId !== null && typeof body.sessionId !== 'number')) {
    return bad(c, 'sessionId must be a number or null')
  }
  const id = body.sessionId as number | null
  // Setting to null always succeeds; setting to a number requires the session to exist.
  if (id !== null) {
    const exists = sessions.getSession(getDb(), id)
    if (!exists) return bad(c, 'session not found', 404)
  }
  sessions.setActiveSessionId(getDb(), id)
  return c.json({ sessionId: id })
})

// ---- /slug ----
// Lightweight one-shot helper for name inputs. It deliberately does not
// create a chat session or persist a message; the result is just a suggested
// filesystem-safe English path segment.
ai.post('/slug', async (c) => {
  const body = await c.req.json().catch(() => null) as
    | { input?: unknown; kind?: unknown }
    | null
  if (
    !body ||
    typeof body.input !== 'string' ||
    (body.kind !== 'file' && body.kind !== 'folder')
  ) {
    return bad(c, 'input (string) and kind (file|folder) required')
  }
  try {
    const slug = await generateSlug({
      input: body.input,
      kind: body.kind,
      signal: c.req.raw.signal,
    })
    return c.json({ slug })
  } catch (err) {
    if (err instanceof ChatError) {
      if (err.reason === 'no-api-key') return bad(c, 'AI not configured', 503)
      if (err.reason === 'key-error') return bad(c, err.message, 503, err.code)
      if (err.reason === 'aborted') return c.json({ error: 'aborted' }, 499 as any)
      if (err.reason === 'parse-failed') return bad(c, err.message, 502)
      return bad(c, err.message || 'llm-error', 502)
    }
    return bad(c, 'unknown', 500)
  }
})

// ---- /summary ----
// Generate a document summary from the current Markdown body. This is
// deliberately independent from Git so it also works for clean documents.
ai.post('/summary', async (c) => {
  c.header('Cache-Control', 'no-store')
  const body = await c.req.json().catch(() => null) as
    | { path?: unknown; content?: unknown; documentId?: unknown; language?: unknown }
    | null
  if (!body || typeof body.path !== 'string' || !isValidPathSyntax(body.path)) {
    return bad(c, 'valid path required')
  }
  if (classifyDiaryPath(normalizeLogicalContentPath(body.path) ?? body.path) === 'managed') {
    return bad(c, 'AI summary is unavailable for managed Diary bodies', 422, 'diary-ai-summary-unsupported')
  }
  const bodyAccess = requireDiaryBodyAccess(c, body.path)
  if (bodyAccess) return bodyAccess
  if (body.content !== undefined && typeof body.content !== 'string') {
    return bad(c, 'content must be a string')
  }
  if (body.documentId !== undefined && typeof body.documentId !== 'string') {
    return bad(c, 'documentId must be a string')
  }
  const language = body.language === 'zh' ? 'zh' : 'en'
  try {
    let content: string
    if (typeof body.content === 'string') {
      if (Buffer.byteLength(body.content, 'utf8') > MAX_SUMMARY_FILE_BYTES) {
        return bad(c, `AI summary content exceeds the ${MAX_SUMMARY_FILE_BYTES}-byte limit`, 413)
      }
      if (body.content.length > MAX_SUMMARY_CONTENT_CHARS) {
        return bad(c, `AI summary content exceeds the ${MAX_SUMMARY_CONTENT_CHARS}-character limit`, 413)
      }
      content = body.content.trim()
    } else {
      const raw = await readSafeRelativeFile(CONTENT_DIR, `${body.path}.md`, 'utf8', {
        maxBytes: MAX_SUMMARY_FILE_BYTES,
        signal: c.req.raw.signal,
      })
      if (raw === null) return bad(c, 'not found', 404)
      content = matter(String(raw)).content.trim()
    }
    if (!content) return bad(c, 'document content is empty')
    const summary = await generateSummary({
      path: body.path,
      content,
      language,
      signal: c.req.raw.signal,
    })
    return c.json({ summary })
  } catch (err) {
    if (c.req.raw.signal.aborted) return c.json({ error: 'aborted' }, 499 as any)
    if (err instanceof SummaryPromptLimitError || err instanceof SafePathResourceLimitError) {
      return bad(c, err.message, 413)
    }
    if (err instanceof ChatError) {
      if (err.reason === 'no-api-key') return bad(c, 'AI not configured', 503)
      if (err.reason === 'key-error') return bad(c, err.message, 503, err.code)
      if (err.reason === 'aborted') return c.json({ error: 'aborted' }, 499 as any)
      if (err.reason === 'parse-failed') return bad(c, err.message, 502)
      return bad(c, err.message || 'llm-error', 502)
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return bad(c, 'not found', 404)
    return bad(c, (err as Error).message || 'unknown', 500)
  }
})

// ---- /commit-message ----
// Lightweight helper for the History composer. It does not create a chat
// session; it reads the selected notes and returns a single subject line.
ai.post('/commit-message', async (c) => {
  c.header('Cache-Control', 'no-store')
  const body = await c.req.json().catch(() => null) as
    | { paths?: unknown; selectedPath?: unknown; diffText?: unknown; language?: unknown }
    | null
  if (!body || !Array.isArray(body.paths)) return bad(c, 'paths array required')
  const paths = validateHistoryPaths(body.paths)
  if (!paths) return bad(c, 'invalid paths')
  if (paths.length > MAX_COMMIT_MESSAGE_PATHS) return bad(c, 'too many paths', 413)
  if (new Set(paths).size !== paths.length) return bad(c, 'duplicate paths')
  if (paths.length === 0) return bad(c, 'at least one path required')
  if (paths.some((filePath) => classifyDiaryPath(filePath.replace(/\.md$/, '')) === 'managed')) {
    return bad(c, 'AI commit-message generation is unavailable for managed Diary bodies', 422, 'diary-ai-commit-message-unsupported')
  }
  for (const filePath of paths) {
    const bodyAccess = requireDiaryBodyAccess(c, filePath)
    if (bodyAccess) return bodyAccess
  }
  let dirtyPaths: Set<string>
  try {
    dirtyPaths = new Set(
      (await historyGit.status(CONTENT_DIR))
        .filter((entry) => validateHistoryPaths([entry.path]) !== null)
        .map((entry) => entry.path),
    )
    if (paths.some((filePath) => !dirtyPaths.has(filePath))) {
      return bad(c, 'path is not changed', 409)
    }
    for (const filePath of paths) {
      await resolveSafeRelativePath(CONTENT_DIR, filePath, { allowMissingFinal: true })
    }
  } catch (error: any) {
    if (error instanceof SafePathResourceLimitError) return bad(c, error.message, 413)
    return bad(c, error?.message || 'invalid paths')
  }
  const selectedPath = typeof body.selectedPath === 'string'
    && paths.includes(body.selectedPath.trim())
    ? body.selectedPath.trim()
    : undefined
  const language = body.language === 'zh' ? 'zh' : 'en'

  try {
    // Keep this endpoint a diff summarizer. The model receives only the
    // server-observed HEAD/WORKTREE delta, never the full current document.
    const changes = await collectCommitChanges(paths, c.req.raw.signal)
    const message = await generateCommitMessage({
      paths,
      selectedPath,
      language,
      changes,
      signal: c.req.raw.signal,
    })
    return c.json({ message })
  } catch (err) {
    if (c.req.raw.signal.aborted) return c.json({ error: 'aborted' }, 499 as any)
    if (err instanceof CommitMessageResourceLimitError
      || err instanceof CommitMessagePromptLimitError
      || err instanceof historyGit.HistoryResourceLimitError
      || err instanceof SafePathResourceLimitError) {
      return bad(c, err.message, 413)
    }
    if (err instanceof ChatError) {
      if (err.reason === 'no-api-key') return bad(c, 'AI not configured', 503)
      if (err.reason === 'key-error') return bad(c, err.message, 503, err.code)
      if (err.reason === 'aborted') return c.json({ error: 'aborted' }, 499 as any)
      if (err.reason === 'parse-failed') return bad(c, err.message, 502)
      return bad(c, err.message || 'llm-error', 502)
    }
    return bad(c, (err as Error).message || 'unknown', 500)
  }
})

// ---- /chat ----
ai.post('/chat', async (c) => {
  c.header('Cache-Control', 'no-store')
  const db = getDb()
  const body = (await c.req.json().catch(() => null)) as
    | {
        sessionId?: unknown
        content?: unknown
        liveContext?: unknown
        currentNotePath?: unknown
        contextPaths?: unknown
      }
    | null
  if (
    !body ||
    typeof body.sessionId !== 'number' ||
    typeof body.content !== 'string'
  ) {
    return c.json({ ok: false, reason: 'invalid' }, 400)
  }
  // Bind to locals so the narrowed types survive into runChat().
  const sessionId = body.sessionId
  const userContent = body.content
  const authSessionId = (c as any).get('authSessionId') as unknown
  const presentedDiaryCapability = readDiaryAccessCapability(c.req.raw.headers)
  const authRuntime = getAuthRuntime()
  const contextPaths = parseChatContextPaths(body.contextPaths)
  if (contextPaths === null) {
    return c.json({ ok: false, reason: 'invalid-context-paths' }, 400)
  }

  // Edit-10.3: normalize the ONE ChatContext authority BEFORE the
  // SSE stream starts, so validation failures land as plain JSON
  // responses the client maps to stable reasons:
  //   liveContext field present → strict parse; malformed → 400
  //     invalid-live-context, oversized → 413 context-too-large.
  //     A malformed snapshot NEVER falls back to the legacy path.
  //   absent + valid currentNotePath → legacy-path (old clients).
  //   neither → none.
  let ctx: ChatContext
  const contextOptions = contextPaths.length ? { contextPaths } : {}
  if (body.liveContext !== undefined) {
    const parsed = parseAiLiveContext(body.liveContext)
    if (!parsed.ok) {
      const status = parsed.reason === 'context-too-large' ? 413 : 400
      return c.json({ ok: false, reason: parsed.reason }, status)
    }
    ctx = { kind: 'live', liveContext: parsed.value, ...contextOptions }
  } else if (isValidLegacyNotePath(body.currentNotePath)) {
    ctx = { kind: 'legacy-path', currentNotePath: body.currentNotePath, ...contextOptions }
  } else {
    ctx = { kind: 'none', ...contextOptions }
  }

  // The AI provider is not an adapter-aware body owner in D8.3. Reject
  // managed Diary paths in every context transport, including the legacy
  // currentNotePath hint and attached contextPaths. Checking only the live
  // snapshot would leave old clients able to ask read_file for an opaque
  // Diary envelope. Do this before provider/client construction or SSE.
  const managedContextPath = [
    ctx.kind === 'live'
      ? ctx.liveContext.identity.path
      : ctx.kind === 'legacy-path'
        ? ctx.currentNotePath
        : undefined,
    ...(ctx.contextPaths ?? []),
  ]
    .map((candidate) => {
      if (typeof candidate !== 'string') return null
      return normalizeLogicalContentPath(candidate) ?? candidate
    })
    .find((candidate) => candidate && classifyDiaryPath(candidate) === 'managed')
  if (managedContextPath) {
    return bad(c, 'Diary AI context is unavailable while encrypted Diary bodies are managed', 422, 'diary-ai-context-unsupported')
  }

  // Resolve provider credentials only after the privacy boundary above. A
  // managed-Diary context must deterministically return its 422 even when AI
  // is not configured; no provider/client setup may observe its bytes.
  let runtimeConfig: ReturnType<typeof resolveAiRuntimeConfig>
  try {
    runtimeConfig = resolveAiRuntimeConfig(db)
  } catch (error) {
    const response = aiKeyErrorResponse(c, error)
    if (response) return response
    throw error
  }
  if (!runtimeConfig.apiKey) {
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: false, reason: 'no-api-key' }, 503)
  }

  // We don't pre-validate the session here — runChat throws
  // ChatError('not-found') and the route maps it to an SSE error
  // event so the client can show a chip rather than a generic 404.
  return streamSSE(c, async (stream) => {
    try {
      const writeEvent = async (e: ChatEvent) => {
        switch (e.type) {
          case 'user':
            await stream.writeSSE({ event: 'user', data: JSON.stringify({ id: e.id }) })
            break
          case 'token':
            await stream.writeSSE({ event: 'token', data: JSON.stringify({ text: e.text }) })
            break
          case 'tool_use':
            await stream.writeSSE({
              event: 'tool_use',
              data: JSON.stringify({ id: e.id, name: e.name, input: e.input }),
            })
            break
          case 'tool_result':
            await stream.writeSSE({
              event: 'tool_result',
              data: JSON.stringify({
                tool_use_id: e.tool_use_id,
                content: e.content,
                is_error: e.is_error,
              }),
            })
            break
          case 'file_changed':
            await stream.writeSSE({
              event: 'file_changed',
              data: JSON.stringify({
                path: e.path,
                kind: e.kind,
                newMtime: e.newMtime,
                newRaw: e.newRaw,
                oldPath: e.oldPath,
              }),
            })
            break
          case 'done':
            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({ userId: e.userId, assistantId: e.assistantId }),
            })
            break
          case 'error':
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({
                reason: e.reason,
                ...(e.code ? { code: e.code } : {}),
                ...(e.message ? { message: safeProviderMessage(e.message, runtimeConfig.apiKey) } : {}),
              }),
            })
            break
        }
      }

      await runChat({
        db,
        sessionId,
        userContent,
        ctx,
        model: runtimeConfig.model,
        diaryBodyAccess: (path) => {
          const canonical = normalizeLogicalContentPath(path)
          if (!canonical || classifyDiaryPath(canonical) !== 'managed') return true
          return Boolean(authRuntime && hasDiaryBodyAccess(authSessionId, presentedDiaryCapability))
        },
        signal: c.req.raw.signal,
        onEvent: writeEvent,
      })
    } catch (err) {
      if (err instanceof ChatError && err.reason === 'aborted') return
      const reason = err instanceof ChatError ? err.reason : 'unknown'
      try {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            reason,
            ...(err instanceof ChatError && err.code ? { code: err.code } : {}),
            ...(err instanceof ChatError && (err.reason === 'llm-error' || err.reason === 'key-error') && err.message
              ? { message: safeProviderMessage(err.message, runtimeConfig.apiKey) }
              : {}),
          }),
        })
      } catch {
        // The stream may already be closed (client disconnect).
        // Best-effort: ignore.
      }
    }
  })
})

export default ai
