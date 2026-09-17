import type { PostSummary, TreeNode } from '../../lib/api'
import { DIARY_ROOT, diaryDateFromPath, type DiaryDate } from '../../../shared/diaryProtocol'
import type { DiaryCalendarDay } from './diaryCalendarAdapter'

type TreeFolder = Extract<TreeNode, { kind: 'folder' }>

/**
 * Find the canonical Diary root in the full Vault tree.
 *
 * The server tree includes a synthetic `content` root, but keeping this
 * lookup structural makes the projection tolerant of the root wrapper being
 * changed without making arbitrary nested folders part of Diary identity.
 */
function diaryRoots(tree: readonly TreeNode[]): TreeFolder[] {
  const roots: TreeFolder[] = []
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        if (node.path === DIARY_ROOT) roots.push(node)
        visit(node.children)
      }
    }
  }
  visit(tree)
  return roots
}

/**
 * Project the authoritative full Vault tree into the minimal Diary calendar
 * model. Only direct file children of the exact `diary/` root can become
 * markers; names, metadata dates, nested paths, and other scopes are never
 * used as Diary identity.
 */
export function projectDiaryDaysFromTree(
  tree: readonly TreeNode[] | null | undefined,
  posts: readonly PostSummary[] | null | undefined = [],
): DiaryCalendarDay[] {
  const postByPath = new Map<string, PostSummary>()
  for (const post of posts ?? []) {
    const date = diaryDateFromPath(post.path)
    if (!date) continue

    const current = postByPath.get(post.path)
    if (!current) {
      postByPath.set(post.path, post)
      continue
    }

    // The API normally returns one summary per path. If a transient or test
    // fixture contains duplicates, prefer the newest valid metadata version
    // and then use the stable document id as a deterministic tie-breaker.
    const currentVersion = Number.isSafeInteger(current.metadataUpdatedAt)
      ? current.metadataUpdatedAt!
      : -1
    const nextVersion = Number.isSafeInteger(post.metadataUpdatedAt)
      ? post.metadataUpdatedAt!
      : -1
    if (
      nextVersion > currentVersion
      || (
        nextVersion === currentVersion
        && typeof post.documentId === 'string'
        && (typeof current.documentId !== 'string' || post.documentId < current.documentId)
      )
    ) postByPath.set(post.path, post)
  }

  const byDate = new Map<DiaryDate, DiaryCalendarDay>()

  for (const root of diaryRoots(tree ?? [])) {
    for (const child of root.children) {
      if (child.kind !== 'file') continue
      const date = diaryDateFromPath(child.path)
      if (!date) continue

      const post = postByPath.get(child.path)
      const projected: DiaryCalendarDay = { date, hasDiary: true }
      if (post) {
        projected.mood = post.mood ?? null
        if (Number.isSafeInteger(post.metadataUpdatedAt)) {
          projected.metadataUpdatedAt = post.metadataUpdatedAt
        }
        if (typeof post.documentId === 'string') projected.documentId = post.documentId
      }
      byDate.set(date, projected)
    }
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}
