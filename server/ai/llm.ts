// Provider-agnostic LLM wrapper.
//
// Three layers:
//
//   1. resolveAiRuntimeConfig(): reads auth + base URL + model from
//      the active provider's DB settings slot. Used by helpers and
//      by the chat backend factory.
//
//   2. generateText(opts): synchronous-shape non-streaming helper.
//      Returns the assembled text response. Used by slug, summary,
//      commit-message, and any other caller that doesn't need token
//      streaming. Dispatches to Anthropic or OpenAI based on the
//      active provider.
//
//   3. ChatBackend abstraction (streamRound) — used by runChat to
//      drive the multi-round tool loop. The chat route never touches
//      SDK specifics; the Anthropic backend reuses the existing
//      streamClaude path and adds message/tool translation, the
//      OpenAI backend implements OpenAI's tool_calls wire format.
//
// Auth + base URL + model + provider all come from the SQLite
// `settings` table (see settings.ts). API keys are stored encrypted
// at rest (AES-256-GCM, keyEncryption.ts) and decrypted transparently
// on read. There is no env-var override path.
import Anthropic from '@anthropic-ai/sdk'
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages'
import OpenAI from 'openai'
import { ChatError } from './errors.js'
import { getDb } from '../db.js'
import {
  AiKeyConfigurationError,
  getAiRuntimeConfig,
  type Provider,
} from './settings.js'
import type { Database as DatabaseT } from 'better-sqlite3'

const MAX_TOKENS = 4096

const OPENAI_TOOLS_UNSUPPORTED_MESSAGE =
  'This OpenAI-compatible endpoint does not support tool calling. Nuvyn chat requires tool calling for workspace actions; use a compatible model/provider.'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeProviderErrorMessage(error: unknown, apiKey: string): string {
  return errorMessage(error).split(apiKey).join('[redacted]')
}

/** Only retry when the provider explicitly rejects the legacy parameter. A
 * bounded, one-way retry keeps ordinary 4xx errors visible and cannot turn a
 * provider outage into an unbounded request loop. */
export function isOpenAiMaxTokensUnsupported(error: unknown): boolean {
  const message = errorMessage(error)
  return /\bmax_tokens\b/i.test(message)
    && /unsupported|not supported|does not support|unknown|unrecognized|invalid|deprecated|not allowed|incompatible/i.test(message)
}

export function isOpenAiToolsUnsupported(error: unknown): boolean {
  const message = errorMessage(error)
  return /tools?|tool_choice|function[ _-]?calling|function[ _-]?call/i.test(message)
    && /unsupported|not supported|does not support|unknown|unrecognized|invalid|not allowed/i.test(message)
}

export type AiConnectionErrorCode =
  | 'ai-connection-timeout'
  | 'ai-authentication-failed'
  | 'ai-model-unavailable'
  | 'ai-connection-failed'
  | 'openai-tools-unsupported'

export class AiConnectionError extends Error {
  readonly code: AiConnectionErrorCode

  constructor(code: AiConnectionErrorCode, message: string) {
    super(message)
    this.name = 'AiConnectionError'
    this.code = code
  }
}

type OpenAiCreate = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>

/** Shared Chat Completions request wrapper for streaming and helper calls. */
async function createOpenAiCompletion(
  client: OpenAI,
  params: Record<string, unknown>,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const create = client.chat.completions.create.bind(client.chat.completions) as unknown as OpenAiCreate
  const first = { ...params, max_tokens: maxTokens }
  try {
    return await create(first, { signal })
  } catch (error) {
    if (!isOpenAiMaxTokensUnsupported(error)) throw error
    // Exactly one compatibility retry. Remove max_tokens rather than sending
    // both fields because several gateways reject a request containing both.
    const { max_tokens: _ignored, ...withoutLegacyLimit } = first
    return create({ ...withoutLegacyLimit, max_completion_tokens: maxTokens }, { signal })
  }
}

const CONNECTION_PROBE_TIMEOUT_MS = 10_000
const CONNECTION_PROBE_MAX_TOKENS = 16

export interface AiConnectionProbeConfig {
  provider: Provider
  apiKey: string
  baseURL?: string
  model: string
}

function connectionErrorCode(error: unknown): Exclude<AiConnectionErrorCode, 'ai-connection-timeout'> {
  const message = errorMessage(error)
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|authentication[\s_-](?:failed|failure|error)|invalid (?:x-)?api[ -]?key|incorrect api key|invalid token/i.test(message)) {
    return 'ai-authentication-failed'
  }
  if (/(?:\b(?:unknown|invalid|unsupported)\s+model\b|\bmodel\b[^\n]{0,120}\b(?:not found|unavailable|does not exist|not available)\b|\bno such model\b)/i.test(message)) {
    return 'ai-model-unavailable'
  }
  return 'ai-connection-failed'
}

function createConnectionSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Execute the smallest non-streaming request that exercises the same
 * provider contract as Nuvyn chat. This is deliberately independent from
 * the database-backed chat backend so transient form values never persist.
 */
export async function probeAiConnection(
  config: AiConnectionProbeConfig,
  parentSignal?: AbortSignal,
  timeoutMs = CONNECTION_PROBE_TIMEOUT_MS,
): Promise<{ provider: Provider; model: string }> {
  const probe = createConnectionSignal(parentSignal, timeoutMs)
  try {
    if (parentSignal?.aborted) throw new AiConnectionError('ai-connection-failed', 'Connection test was cancelled')

    if (config.provider === 'openai') {
      const client = new OpenAI({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        maxRetries: 0,
      })
      let response: any
      try {
        response = await createOpenAiCompletion(client, {
          model: config.model,
          messages: [
            { role: 'system', content: 'Nuvyn connection probe.' },
            { role: 'user', content: 'Reply OK.' },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'nuvyn_connection_probe',
              description: 'A harmless connection probe. Do not call unless needed.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          }],
          tool_choice: 'auto',
          stream: false,
        }, CONNECTION_PROBE_MAX_TOKENS, probe.signal)
      } catch (error) {
        if (probe.didTimeout()) {
          throw new AiConnectionError('ai-connection-timeout', 'Connection timed out while contacting the AI provider')
        }
        if (parentSignal?.aborted) {
          throw new AiConnectionError('ai-connection-failed', 'Connection test was cancelled')
        }
        if (isOpenAiToolsUnsupported(error)) {
          throw new AiConnectionError(
            'openai-tools-unsupported',
            `${OPENAI_TOOLS_UNSUPPORTED_MESSAGE} Upstream: ${safeProviderErrorMessage(error, config.apiKey)}`,
          )
        }
        throw new AiConnectionError(
          connectionErrorCode(error),
          safeProviderErrorMessage(error, config.apiKey),
        )
      }
      if (!response?.choices?.[0]?.message) {
        throw new AiConnectionError('ai-connection-failed', 'The AI provider returned an empty response')
      }
      return { provider: config.provider, model: config.model }
    }

    const client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      maxRetries: 0,
    })
    let response: any
    try {
      response = await client.messages.create({
        model: config.model,
        max_tokens: CONNECTION_PROBE_MAX_TOKENS,
        system: 'Nuvyn connection probe.',
        messages: [{ role: 'user', content: 'Reply OK.' }],
        tools: [{
          name: 'nuvyn_connection_probe',
          description: 'A harmless connection probe. Do not call unless needed.',
          input_schema: { type: 'object', properties: {}, additionalProperties: false },
        }],
        tool_choice: { type: 'auto' },
      }, { signal: probe.signal })
    } catch (error) {
      if (probe.didTimeout()) {
        throw new AiConnectionError('ai-connection-timeout', 'Connection timed out while contacting the AI provider')
      }
      if (parentSignal?.aborted) {
        throw new AiConnectionError('ai-connection-failed', 'Connection test was cancelled')
      }
      throw new AiConnectionError(connectionErrorCode(error), safeProviderErrorMessage(error, config.apiKey))
    }
    if (!response?.content?.length) {
      throw new AiConnectionError('ai-connection-failed', 'The AI provider returned an empty response')
    }
    return { provider: config.provider, model: config.model }
  } finally {
    probe.cleanup()
  }
}

export type StreamResult = {
  text: string
  finalMessage: Message
}

/* ------------------------------------------------------------------ *
 * Normalized message + tool shapes
 *
 * Both providers have the same conceptual model: a list of messages
 * with role + content blocks, plus a list of tool definitions and
 * tool calls. The wire formats differ (Anthropic uses content blocks
 * with type: 'tool_use' / 'tool_result'; OpenAI uses tool_calls on
 * assistant messages and role: 'tool' messages). The normalized
 * shapes below are what the chat orchestrator (chat.ts) works with;
 * each ChatBackend implementation translates to its provider's
 * native form on the way in and back on the way out.
 * ------------------------------------------------------------------ */

export type NormalizedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool'
  /* When role is 'user' / 'tool' / 'assistant' with no tool_use, this
     is a plain string. When role is 'assistant' and the assistant
     emitted tool calls, content is an array of NormalizedBlock so
     we can carry both text and tool_use blocks together. */
  content: string | NormalizedBlock[]
  /* Required only when role === 'tool' — the id of the tool_use
     block whose result this is. */
  tool_call_id?: string
}

export interface NormalizedTool {
  name: string
  description: string
  /* JSON Schema object describing the tool's parameters. */
  parameters: Record<string, unknown>
}

export interface NormalizedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface StreamRoundOpts {
  db: DatabaseT
  model: string
  system: string
  messages: NormalizedMessage[]
  tools: NormalizedTool[]
  onToken: (text: string) => void
  signal?: AbortSignal
}

export interface StreamRoundResult {
  text: string
  toolCalls: NormalizedToolCall[]
  /* Why the round stopped. 'stop' = model produced a final answer,
     'tool_calls' = model wants to call tools (loop again),
     'length' = hit the output token limit. */
  finishReason: 'stop' | 'tool_calls' | 'length'
}

export interface ChatBackend {
  readonly name: Provider
  streamRound(opts: StreamRoundOpts): Promise<StreamRoundResult>
}

/* ------------------------------------------------------------------ *
 * Anthropic backend — wraps the existing streamClaude path
 * ------------------------------------------------------------------ */

class AnthropicBackend implements ChatBackend {
  readonly name = 'anthropic' as const

  async streamRound(opts: StreamRoundOpts): Promise<StreamRoundResult> {
    const cfg = resolveAiRuntimeConfig(opts.db)
    if (!cfg.apiKey) throw new ChatError('no-api-key')
    const client = new Anthropic(cfg.baseURL ? { apiKey: cfg.apiKey, baseURL: cfg.baseURL } : { apiKey: cfg.apiKey })

    // Translate NormalizedMessage[] → Anthropic.MessageParam[]. The
    // model only ever needs to see role + content; tool messages
    // become a user turn with tool_result blocks (Anthropic's wire
    // format requires this).
    const anthropicMessages = opts.messages.map((m): Anthropic.MessageParam => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id ?? '',
              content: typeof m.content === 'string' ? m.content : '',
              is_error: false,
            },
          ],
        }
      }
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        return { role: 'assistant', content: m.content as Anthropic.ContentBlockParam[] }
      }
      return { role: m.role, content: typeof m.content === 'string' ? m.content : '' }
    })

    const tools: Anthropic.Tool[] = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }))

    const stream = client.messages.stream({
      model: opts.model,
      max_tokens: MAX_TOKENS,
      system: opts.system,
      messages: anthropicMessages,
      tools,
      tool_choice: { type: 'auto' },
    })

    const result = await pumpStream(
      stream as unknown as Parameters<typeof pumpStream>[0],
      opts.onToken,
      opts.signal,
    )

    const toolCalls: NormalizedToolCall[] = []
    let text = ''
    for (const block of result.finalMessage.content) {
      if (block.type === 'text') text += block.text
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }
    const finishReason: StreamRoundResult['finishReason'] =
      result.finalMessage.stop_reason === 'tool_use' ? 'tool_calls'
      : result.finalMessage.stop_reason === 'max_tokens' ? 'length'
      : 'stop'
    return { text, toolCalls, finishReason }
  }
}

/* ------------------------------------------------------------------ *
 * OpenAI backend — implements chat.completions.create({stream:true})
 * with tool_calls in OpenAI's wire format
 * ------------------------------------------------------------------ */

class OpenAIBackend implements ChatBackend {
  readonly name = 'openai' as const

  async streamRound(opts: StreamRoundOpts): Promise<StreamRoundResult> {
    const cfg = resolveAiRuntimeConfig(opts.db)
    if (!cfg.apiKey) throw new ChatError('no-api-key')
    const client = new OpenAI({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    })

    // Translate NormalizedMessage[] → OpenAI ChatCompletionMessageParam[].
    // Each Anthropic-style assistant turn (content blocks with text +
    // tool_use) becomes one OpenAI assistant message with text +
    // tool_calls. Each tool result becomes its own role:'tool' message
    // paired by tool_call_id (which OpenAI requires; Anthropic uses a
    // single user turn with tool_result blocks, but OpenAI expects one
    // role:'tool' message per tool call).
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = []
    openaiMessages.push({ role: 'system', content: opts.system })
    for (const m of opts.messages) {
      if (m.role === 'user') {
        openaiMessages.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '' })
      } else if (m.role === 'tool') {
        openaiMessages.push({
          role: 'tool',
          tool_call_id: m.tool_call_id ?? '',
          content: typeof m.content === 'string' ? m.content : '',
        })
      } else {
        // Assistant
        if (Array.isArray(m.content)) {
          const textParts: string[] = []
          const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = []
          for (const b of m.content as NormalizedBlock[]) {
            if (b.type === 'text') textParts.push(b.text)
            else if (b.type === 'tool_use') {
              toolCalls.push({
                id: b.id,
                type: 'function',
                function: {
                  name: b.name,
                  // OpenAI requires arguments as a JSON string, not an object.
                  arguments: JSON.stringify(b.input),
                },
              })
            }
          }
          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: textParts.join('') || null,
          }
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
          openaiMessages.push(assistantMsg)
        } else {
          openaiMessages.push({ role: 'assistant', content: m.content as string })
        }
      }
    }

    const tools: OpenAI.ChatCompletionTool[] = opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }))

    let response
    try {
      response = await createOpenAiCompletion(client, {
        model: opts.model,
        messages: openaiMessages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
        stream: true,
      }, MAX_TOKENS, opts.signal) as AsyncIterable<OpenAI.ChatCompletionChunk>
    } catch (err) {
      if (opts.signal?.aborted) throw new ChatError('aborted')
      if (tools.length > 0 && isOpenAiToolsUnsupported(err)) {
        throw new ChatError(
          'llm-error',
          `${OPENAI_TOOLS_UNSUPPORTED_MESSAGE} Upstream: ${safeProviderErrorMessage(err, cfg.apiKey)}`,
          undefined,
          'openai-tools-unsupported',
        )
      }
      throw new ChatError('llm-error', safeProviderErrorMessage(err, cfg.apiKey))
    }

    /* OpenAI streams ChatCompletionChunk objects. Each chunk may carry
       a content delta in `delta.content` and/or a partial tool_calls
       update in `delta.tool_calls`. We accumulate text and assemble
       the tool_call deltas into complete tool calls (each OpenAI
       tool_call may arrive across several chunks — id in the first,
       function name later, arguments in pieces). */
    let text = ''
    const toolCallAccum = new Map<number, { id?: string; name?: string; arguments: string }>()
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop'
    for await (const chunk of response) {
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta
      if (delta?.content) {
        text += delta.content
        // Keep the normalized backend contract identical to Anthropic:
        // runChat uses onToken both to stream the UI and to build the
        // assistant text that is persisted after the round. Without this
        // callback, an otherwise successful OpenAI response ended with an
        // empty assistant message and failed SQLite persistence.
        await opts.onToken(delta.content)
      }
      for (const tcDelta of delta?.tool_calls ?? []) {
        const entry = toolCallAccum.get(tcDelta.index) ?? { arguments: '' }
        if (tcDelta.id) entry.id = tcDelta.id
        if (tcDelta.function?.name) entry.name = `${entry.name ?? ''}${tcDelta.function.name}`
        if (tcDelta.function?.arguments) entry.arguments += tcDelta.function.arguments
        toolCallAccum.set(tcDelta.index, entry)
      }
      if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls'
      else if (choice.finish_reason === 'length') finishReason = 'length'
      else if (choice.finish_reason === 'stop') finishReason = 'stop'
    }

    const toolCalls: NormalizedToolCall[] = []
    for (const [, entry] of toolCallAccum) {
      if (!entry.id || !entry.name) continue
      let parsed: Record<string, unknown> = {}
      try {
        parsed = entry.arguments ? JSON.parse(entry.arguments) : {}
      } catch {
        // Model emitted malformed JSON in arguments; surface as empty
        // input — the tool's runtime validation will reject it.
        parsed = {}
      }
      toolCalls.push({ id: entry.id, name: entry.name, input: parsed })
    }
    return { text, toolCalls, finishReason }
  }
}

/* ------------------------------------------------------------------ *
 * Backend factory — caches the singleton so the chat loop doesn't
 * rebuild it every round. Recreated when the active provider changes
 * (callers can call clearChatBackendCache() after PUT /settings).
 * ------------------------------------------------------------------ */

let cachedBackend: ChatBackend | null = null
let cachedProvider: Provider | null = null

export function getChatBackend(db: DatabaseT, provider?: Provider): ChatBackend {
  const target = provider ?? getAiRuntimeConfig(db).provider
  if (cachedBackend && cachedProvider === target) return cachedBackend
  cachedBackend = target === 'openai' ? new OpenAIBackend() : new AnthropicBackend()
  cachedProvider = target
  return cachedBackend
}

/* Call after PUT /settings changes the provider so the next round
   uses the right backend. */
export function clearChatBackendCache(): void {
  cachedBackend = null
  cachedProvider = null
}

/* ------------------------------------------------------------------ *
 * Anthropic stream pump (kept as-is for runChat's internal use)
 * ------------------------------------------------------------------ */

export type StreamClaudeOpts = {
  system: string
  messages: { role: 'user' | 'assistant'; content: string | unknown[] }[]
  model: string
  onToken: (text: string) => void
  signal?: AbortSignal
  tools?: Anthropic.Tool[]
  toolChoice?: Anthropic.ToolChoice
}

/**
 * Process an Anthropic MessageStream and resolve with the
 * accumulated text + the final Message. `onToken` is called for every
 * text delta. Throws ChatError('aborted') on signal abort,
 * ChatError('llm-error') on stream or finalization failure.
 */
export async function pumpStream(
  stream: {
    on: (event: string, cb: (arg: any) => void) => void
    finalMessage: () => Promise<unknown>
  },
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ChatError('aborted'))
      return
    }
    let fullText = ''
    stream.on('text', (text: string) => {
      fullText += text
      onToken(text)
    })
    stream.on('error', (err: Error) => {
      reject(new ChatError('llm-error', err.message))
    })
    stream.finalMessage()
      .then((m) => resolve({ text: fullText, finalMessage: m as Message }))
      .catch((err: Error) => reject(new ChatError('llm-error', err.message)))
    signal?.addEventListener('abort', () => {
      reject(new ChatError('aborted'))
    })
  })
}

/**
 * Open a streaming Claude call and resolve with the final text and
 * full Message. Direct Anthropic-only export kept for any caller
 * that needs the Anthropic Message shape (tests, or future code
 * that wants to inspect the SDK's native types). The chat route
 * uses the ChatBackend abstraction instead.
 */
export async function streamClaude(opts: StreamClaudeOpts): Promise<StreamResult> {
  const cfg = resolveAiRuntimeConfig()
  if (!cfg.apiKey) throw new ChatError('no-api-key')
  if (cfg.provider !== 'anthropic') {
    throw new ChatError(
      'unsupported-provider',
      `streamClaude() is Anthropic-only; active provider is "${cfg.provider}". Use ChatBackend via getChatBackend() for cross-provider chat.`,
    )
  }
  const client = new Anthropic(cfg.baseURL ? { apiKey: cfg.apiKey, baseURL: cfg.baseURL } : { apiKey: cfg.apiKey })
  const stream = client.messages.stream({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: opts.system,
    messages: opts.messages as Anthropic.MessageParam[],
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
  })
  return pumpStream(stream as unknown as Parameters<typeof pumpStream>[0], opts.onToken, opts.signal)
}

/**
 * Resolve the auth token from the active provider's DB settings.
 * Narrow export for older callers/tests that only need the bit;
 * new code should prefer resolveAiRuntimeConfig() when it also
 * needs model/baseURL/provider.
 */
export function resolveApiKey(): string | undefined {
  return resolveAiRuntimeConfig().apiKey
}

export function resolveAiRuntimeConfig(db: DatabaseT = getDb()) {
  try {
    return getAiRuntimeConfig(db)
  } catch (error) {
    if (error instanceof AiKeyConfigurationError) {
      throw new ChatError('key-error', error.message, undefined, error.code)
    }
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * generateText — provider-agnostic non-streaming helper
 * ------------------------------------------------------------------ */

export interface GenerateTextOpts {
  system: string
  user: string
  model: string
  maxTokens: number
  temperature?: number
  signal?: AbortSignal
}

export interface GenerateTextResult {
  text: string
  finishReason: 'stop' | 'length' | 'other'
}

function normalizeOpenAiFinishReason(reason: unknown): GenerateTextResult['finishReason'] {
  if (reason === 'stop') return 'stop'
  if (reason === 'length') return 'length'
  return 'other'
}

function normalizeAnthropicFinishReason(reason: unknown): GenerateTextResult['finishReason'] {
  if (reason === 'max_tokens') return 'length'
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  return 'other'
}

export async function generateText(opts: GenerateTextOpts): Promise<GenerateTextResult> {
  const cfg = resolveAiRuntimeConfig()
  if (!cfg.apiKey) throw new ChatError('no-api-key')
  if (cfg.provider === 'openai') {
    const client = new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })
    let response
    try {
      response = await createOpenAiCompletion(client, {
        model: opts.model,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }, opts.maxTokens, opts.signal) as OpenAI.ChatCompletion
    } catch (err) {
      if (opts.signal?.aborted) throw new ChatError('aborted')
      throw new ChatError('llm-error', safeProviderErrorMessage(err, cfg.apiKey))
    }
    const choice = response.choices?.[0]
    const message = choice?.message
    const text = typeof message?.content === 'string' ? message.content : ''
    return {
      text,
      finishReason: message
        ? normalizeOpenAiFinishReason(choice?.finish_reason)
        : 'other',
    }
  }
  // Anthropic (default)
  const client = new Anthropic(cfg.baseURL ? { apiKey: cfg.apiKey, baseURL: cfg.baseURL } : { apiKey: cfg.apiKey })
  let response
  try {
    response = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
    }, { signal: opts.signal })
  } catch (err) {
    if (opts.signal?.aborted) throw new ChatError('aborted')
    throw new ChatError('llm-error', (err as Error).message)
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { text, finishReason: normalizeAnthropicFinishReason(response.stop_reason) }
}
