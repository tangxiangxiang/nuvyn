import { onScopeDispose, shallowRef } from 'vue'
import type { DocumentExportSnapshot } from '../../lib/documentExport'
import { HTML_EXPORT_LIMITS, checkExportSignal } from '../../lib/htmlExportResources'

export function useHtmlDocumentExport() {
  const request = shallowRef<{ id: number; snapshot: DocumentExportSnapshot; signal: AbortSignal } | null>(null)
  let sequence = 0
  let finish: ((error?: unknown, html?: string) => void) | null = null
  function run(snapshot: DocumentExportSnapshot, signal: AbortSignal): Promise<string> {
    checkExportSignal(signal)
    return new Promise((resolve, reject) => {
      const abort = () => done(new DOMException('Export cancelled', 'AbortError'))
      const timer = setTimeout(() => done(new Error('HTML_EXPORT_TIMEOUT')), HTML_EXPORT_LIMITS.transactionMs)
      const done = (error?: unknown, html?: string) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        request.value = null
        finish = null
        if (error) reject(error)
        else resolve(html ?? '')
      }
      finish = done
      signal.addEventListener('abort', abort, { once: true })
      request.value = { id: ++sequence, snapshot, signal }
    })
  }
  onScopeDispose(() => finish?.(new DOMException('Export cancelled', 'AbortError')))
  return { request, run, complete: (html: string) => finish?.(undefined, html), failed: (error: unknown) => finish?.(error) }
}
