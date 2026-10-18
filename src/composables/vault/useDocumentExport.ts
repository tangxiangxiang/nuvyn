import { onScopeDispose, ref, type Ref } from 'vue'
import {
  canExportMarkdownDocument,
  downloadMarkdownDocument,
  type DocumentExportFormat,
  type DocumentExportSnapshot,
} from '../../lib/documentExport'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'

export function useDocumentExport(options: {
  pdfBusy: Ref<boolean>
  snapshot: (path: string) => Promise<DocumentExportSnapshot>
  exportPdf: (path: string) => Promise<boolean>
  onBusy: () => void
  onError: () => void
}) {
  const target = ref<string | null>(null)
  const busy = ref(false)
  let generation = 0
  let disposed = false

  function cancel(): void {
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
    const isCurrent = () => !disposed && current === generation
    try {
      if (format === 'pdf') {
        if (!await options.exportPdf(path)) return
      } else if (format === 'markdown') {
        const snapshot = await options.snapshot(path)
        if (!isCurrent()) return
        downloadMarkdownDocument(snapshot, isCurrent)
      } else return
      if (isCurrent()) target.value = null
    } catch {
      if (isCurrent()) options.onError()
    } finally {
      if (isCurrent()) busy.value = false
    }
  }

  onScopeDispose(() => {
    disposed = true
    cancel()
  })
  return { target, busy, request, close, run, cancel }
}
