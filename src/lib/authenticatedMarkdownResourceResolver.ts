import { isManagedDiaryPath } from '../../shared/diaryProtocol'
import { authFetchForPath } from './diary-request'
import {
  MarkdownResourceError,
  type MarkdownResourceReadResult,
  type MarkdownResourceResolver,
} from './markdownResources'

async function readJsonError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null
  const code = typeof body?.code === 'string' ? body.code : 'resource-unavailable'
  throw new MarkdownResourceError(code)
}

/** Browser-only resolver kept separate from the shared Markdown resource parser. */
export const authenticatedMarkdownResourceResolver: MarkdownResourceResolver = {
  async read(request): Promise<MarkdownResourceReadResult> {
    const query = new URLSearchParams({ kind: request.kind, path: request.path })
    if (request.sourcePath && isManagedDiaryPath(request.sourcePath.replace(/\.md$/, ''))) {
      query.set('source', request.sourcePath.replace(/\.md$/, ''))
    }
    // A managed Diary source authorizes the resource expansion through the
    // existing Diary capability even when the included/snippet resource is an
    // ordinary path. Selecting auth by resource path alone would omit that
    // capability and incorrectly fail every unlocked cross-file resource.
    const response = await authFetchForPath(request.sourcePath ?? request.path, `/api/markdown-resources?${query.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
      signal: request.signal,
    })
    if (!response.ok) return readJsonError(response)
    if (request.kind === 'image') {
      return { kind: request.kind, path: request.path, content: new Uint8Array(await response.arrayBuffer()) }
    }
    const body = await response.json().catch(() => null) as { content?: unknown } | null
    if (typeof body?.content !== 'string') throw new MarkdownResourceError('resource-invalid-response')
    return { kind: request.kind, path: request.path, content: body.content }
  },
}
