import { ApiRequestError } from './apiErrors.js'

function declaredLengthExceeds(request: Request, maxBytes: number): boolean {
  const value = request.headers.get('content-length')?.trim()
  if (!value || !/^\d+$/.test(value)) return false
  try {
    return BigInt(value) > BigInt(maxBytes)
  } catch {
    return true
  }
}

/** Read a request body with an early Content-Length check and a bounded stream. */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  tooLargeCode: string,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  if (declaredLengthExceeds(request, maxBytes)) {
    throw new ApiRequestError(tooLargeCode, 413, tooLargeMessage)
  }

  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) {
        throw new ApiRequestError('INVALID_REQUEST_BODY', 400, 'Request body is invalid')
      }
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ApiRequestError(tooLargeCode, 413, tooLargeMessage)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get('content-type')
  if (contentType && /^application\/json\s*(?:;|$)/i.test(contentType)) return
  throw new ApiRequestError(
    'invalid-content-type',
    415,
    'Content-Type must be application/json.',
  )
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
  tooLargeCode: string,
  tooLargeMessage: string,
): Promise<unknown> {
  assertJsonContentType(request)
  const bytes = await readBoundedBody(request, maxBytes, tooLargeCode, tooLargeMessage)
  if (bytes.byteLength === 0) {
    throw new ApiRequestError('INVALID_JSON', 400, 'Request body must contain valid JSON')
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ApiRequestError('INVALID_JSON', 400, 'Request body must contain valid JSON')
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ApiRequestError('INVALID_JSON', 400, 'Request body must contain valid JSON')
  }
}
