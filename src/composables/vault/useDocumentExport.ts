import { onScopeDispose, ref, type Ref } from 'vue'
import {
  canExportMarkdownDocument,
  downloadMarkdownDocument,
  type DocumentExportFormat,
  type DocumentExportSnapshot,
} from '../../lib/documentExport'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'
import { captureAuthSessionGeneration, subscribeAuthSessionRequired } from '../../lib/auth-session'
import { abortableExport, checkExportSignal, HTML_EXPORT_LIMITS } from '../../lib/htmlExportResources'

export function useDocumentExport(options: {
  pdfBusy: Ref<boolean>
  snapshot: (path: string) => Promise<DocumentExportSnapshot>
  exportPdf: (path: string) => Promise<boolean>
  exportHtml: (snapshot: DocumentExportSnapshot, signal: AbortSignal) => Promise<string>
  onBusy: () => void
  onError: () => void
}) {
  const target = ref<string | null>(null)
  const busy = ref(false)
  let generation = 0
  let disposed = false
  let htmlController: AbortController | null = null
  let exportAuthGeneration = captureAuthSessionGeneration()
  const stopAuth = subscribeAuthSessionRequired((event) => {
    if (event.generation === exportAuthGeneration) cancel()
  })

  function cancel(): void {
    htmlController?.abort()
    htmlController = null
    generation += 1
    target.value = null
    busy.value = false
  }

  function request(path: string): void {
    if (disposed) return
    if (busy.value || options.pdfBusy.value) {
      options.onBusy()
      return
    }
    // Preserve the existing authorized Diary PDF command, without exposing a
    // format dialog (or capturing decrypted content for Markdown).
    if (isManagedDiaryPath(path.replace(/\.md$/iu, ''))) {
      void options.exportPdf(path)
      return
    }
    if (!canExportMarkdownDocument(path)) return
    exportAuthGeneration = captureAuthSessionGeneration()
    target.value = path
  }

  function close(): void {
    if (!busy.value) target.value = null
  }

  async function run(format: DocumentExportFormat): Promise<void> {
    const path = target.value
    if (disposed || !path || busy.value || options.pdfBusy.value) return
    if (!canExportMarkdownDocument(path)) return
    busy.value = true
    const current = ++generation
    const authGeneration = captureAuthSessionGeneration()
    exportAuthGeneration = authGeneration
    const isCurrent = () => !disposed && current === generation && authGeneration === captureAuthSessionGeneration()
    try {
      if (format === 'pdf') {
        if (!await options.exportPdf(path)) return
      } else if (format === 'markdown') {
        const snapshot = await options.snapshot(path)
        if (!isCurrent()) return
        downloadMarkdownDocument(snapshot, isCurrent)
      } else if (format === 'html') {
        const controller = new AbortController()
        htmlController = controller
        const timer = setTimeout(() => controller.abort(), HTML_EXPORT_LIMITS.transactionMs)
        controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
        const snapshot = await abortableExport(options.snapshot(path), controller.signal)
        if (!isCurrent()) return
        const html = await options.exportHtml(snapshot, controller.signal)
        if (!isCurrent()) return
        checkExportSignal(controller.signal)
        const { downloadHtmlDocument } = await import('../../lib/htmlExport')
        if (!isCurrent()) return
        checkExportSignal(controller.signal)
        downloadHtmlDocument(snapshot, html, () => isCurrent() && !controller.signal.aborted)
      } else return
      if (isCurrent()) target.value = null
    } catch {
      if (isCurrent()) options.onError()
    } finally {
      if (!disposed && current === generation) {
        if (authGeneration !== captureAuthSessionGeneration()) target.value = null
        htmlController?.abort()
        htmlController = null
        busy.value = false
      }
    }
  }

  onScopeDispose(() => {
    stopAuth()
    disposed = true
    cancel()
  })
  return { target, busy, request, close, run, cancel }
}
