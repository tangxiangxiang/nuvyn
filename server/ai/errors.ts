// Tagged error class for the AI chat flow. Every failure surfaced
// from server/ai/{llm,chat}.ts is an instance of ChatError with a
// stable `reason` string. The route layer maps reason → HTTP status
// or SSE event type; nothing else inspects the class.
import type { AiErrorCode } from './settings.js'

export type ChatErrorReason =
  | 'no-api-key'
  | 'key-error'
  | 'not-found'
  | 'empty'
  | 'aborted'
  | 'llm-error'
  | 'parse-failed'
  | 'unsupported-provider'

export class ChatError extends Error {
  readonly reason: ChatErrorReason
  readonly assistantId?: number
  readonly code?: AiErrorCode
  constructor(
    reason: ChatErrorReason,
    message?: string,
    assistantId?: number,
    code?: AiErrorCode,
  ) {
    super(message ?? reason)
    this.name = 'ChatError'
    this.reason = reason
    this.assistantId = assistantId
    this.code = code
  }
}
