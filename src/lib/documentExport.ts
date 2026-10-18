import { classifyDiaryPath } from '../../shared/diaryProtocol'

export type DocumentExportFormat = 'markdown' | 'pdf'

export interface DocumentExportSnapshot {
  readonly path: string
  readonly raw: string
  readonly title: string
  readonly filename: string
}

interface ExportTab {
  path: string
  raw: string
  title: string
  loading: boolean
  loadError?: string | null
}

export interface DocumentExportSources {
  tabs: readonly ExportTab[]
  posts: readonly { path: string; title?: string }[]
  getPost: (path: string) => Promise<{ raw: string; metadata?: { title?: string } }>
}

export function canExportMarkdownDocument(path: string): boolean {
  // Only canonical logical paths are accepted. Do not let an alias containing
  // dot segments or backslashes bypass the existing managed Diary classifier.
  if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) return false
  const kind = classifyDiaryPath(path.replace(/\.md$/iu, ''))
  return kind === 'outside' || kind === 'unmanaged'
}

export function markdownExportFilename(path: string): string {
  const basename = path.split('/').pop() ?? ''
  let stem = basename.replace(/\.md$/iu, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '-')
    .trim().replace(/[. ]+$/u, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) stem = `_${stem}`
  // A byte bound also keeps Chinese/Emoji names within filesystem limits.
  const encoder = new TextEncoder()
  let bounded = ''
  for (const character of stem) {
    if (encoder.encode(bounded + character).length > 200) break
    bounded += character
  }
  return `${bounded.trim().replace(/[. ]+$/u, '') || 'nuvyn-document'}.md`
}

export async function captureDocumentExportSnapshot(
  path: string,
  sources: DocumentExportSources,
): Promise<DocumentExportSnapshot> {
  const tab = sources.tabs.find((candidate) => candidate.path === path)
  const summary = sources.posts.find((candidate) => candidate.path === path)
  let title = tab?.title || summary?.title || ''
  let raw: string
  if (tab && !tab.loading && !tab.loadError) {
    raw = tab.raw
  } else {
    const post = await sources.getPost(path)
    raw = post.raw
    title = post.metadata?.title?.trim() || title
  }
  return Object.freeze({ path, raw, title, filename: markdownExportFilename(path) })
}

export function downloadMarkdownDocument(
  snapshot: DocumentExportSnapshot,
  isCurrent: () => boolean = () => true,
): void {
  if (!canExportMarkdownDocument(snapshot.path)) throw new Error('MARKDOWN_EXPORT_NOT_ALLOWED')
  if (!isCurrent()) return
  const blob = new Blob([snapshot.raw], { type: 'text/markdown;charset=utf-8', endings: 'transparent' })
  const url = URL.createObjectURL(blob)
  let anchor: HTMLAnchorElement | null = null
  let started = false
  try {
    if (!isCurrent()) return
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = markdownExportFilename(snapshot.path)
    anchor.hidden = true
    document.body.append(anchor)
    if (!isCurrent()) return
    anchor.click()
    started = true
  } finally {
    anchor?.remove()
    // Safari can consume a download URL after click() returns. Keep only the
    // URL alive for a bounded grace period; no component/UI state is retained.
    if (started) window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    else URL.revokeObjectURL(url)
  }
}
