import { classifyDiaryPath, diaryDateFromPath, type DiaryDate } from '../../../shared/diaryProtocol'
import { getMoodDefinition } from '../../../shared/diaryMood'
import { diaryDateFromLocalDate } from '../../components/diary/diaryCalendarAdapter'
import { subscribeDiaryTeardown } from '../../composables/diary/useDiaryAccessSession'
import { getPost, type TreeNode } from '../../lib/api'

export interface DiaryAnalysisExportDto {
  readonly version: 1
  readonly exportedAt: string
  readonly filter: string
  readonly entries: readonly {
    date: DiaryDate
    mood: { id: string; label: string | null } | null
    content: string
  }[]
}

/** Consume the final FileTree projection; never re-interpret its query. */
export function managedDiaryPathsInProjection(nodes: readonly TreeNode[]): string[] {
  const paths = new Set<string>()
  const walk = (node: TreeNode): void => {
    if (node.kind === 'folder') node.children.forEach(walk)
    else if (classifyDiaryPath(node.path) === 'managed') paths.add(node.path)
  }
  nodes.forEach(walk)
  return [...paths]
}

export async function loadDiaryAnalysisExport(
  snapshot: { filter: string; documents: readonly { path: string; mood: string | null }[] },
  options: {
    isCurrent: () => boolean
    liveRawForPath: (path: string) => string | undefined
    customIconNames: Readonly<Record<string, string>>
    locale: 'zh' | 'en'
  },
): Promise<DiaryAnalysisExportDto | null> {
  if (!options.isCurrent()) return null
  const filter = snapshot.filter
  const documents = snapshot.documents
    .filter(({ path }) => classifyDiaryPath(path) === 'managed')
    .map((document) => ({ ...document, date: diaryDateFromPath(document.path)! }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  if (!documents.length) return null

  const entries: DiaryAnalysisExportDto['entries'][number][] = []
  let invalidated = false
  const isCurrent = () => !invalidated && options.isCurrent()
  // Clear partial plaintext synchronously at the existing owner's teardown,
  // even while a canonical body request is still pending. No export cache.
  const unsubscribe = subscribeDiaryTeardown(() => {
    invalidated = true
    entries.length = 0
  })
  try {
    for (const document of documents) {
      if (!isCurrent()) return null
      let raw = options.liveRawForPath(document.path)
      let moodId = document.mood
      if (raw === undefined) {
        const post = await getPost(document.path)
        if (!isCurrent()) return null
        raw = post.raw
        if (post.metadata) moodId = post.metadata.mood
      }
      if (!isCurrent()) return null
      const definition = moodId ? getMoodDefinition(moodId) : undefined
      const label = definition
        ? options.locale === 'zh' ? definition.zhLabel : definition.enLabel
        : moodId && Object.hasOwn(options.customIconNames, moodId) ? options.customIconNames[moodId] || null : null
      entries.push({ date: document.date, mood: moodId ? { id: moodId, label } : null, content: raw })
    }
    if (!isCurrent()) return null
    return { version: 1, exportedAt: new Date().toISOString(), filter, entries }
  } finally {
    unsubscribe()
    if (!isCurrent()) entries.length = 0
  }
}

/** The caller supplies its captured session fence, including view disposal. */
export function downloadDiaryAnalysisExport(data: DiaryAnalysisExportDto, isCurrent: () => boolean): void {
  if (!isCurrent() || !data.entries.length) return
  const exportedAt = new Date(data.exportedAt)
  const date = diaryDateFromLocalDate(exportedAt)
  if (!date) throw new Error('Diary analysis export date is unavailable')
  const time = [exportedAt.getHours(), exportedAt.getMinutes(), exportedAt.getSeconds()].map((value) => String(value).padStart(2, '0')).join('-')
  const json = JSON.stringify(data, null, 2)
  if (!isCurrent()) return
  const blob = new Blob([json], { type: 'application/json' })
  if (!isCurrent()) return
  const objectUrl = URL.createObjectURL(blob)
  let anchor: HTMLAnchorElement | undefined
  try {
    if (!isCurrent()) return
    anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `nuvyn-diary-${date}_${time}.json`
    anchor.hidden = true
    document.body.appendChild(anchor)
    if (isCurrent()) anchor.click()
  } finally {
    anchor?.remove()
    URL.revokeObjectURL(objectUrl)
  }
}
