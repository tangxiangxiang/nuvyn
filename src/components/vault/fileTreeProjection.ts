import type { PostSummary, TreeNode } from '../../lib/api'
import { matchesTagQuery, type TagQuery } from '../../lib/tags'
import { scopeRootsFor, type ScopeKey } from '../../../shared/scopeProtocol'

/** The FileTree presentation projection, shared with scoped analysis exports. */
export function projectFileTree(options: {
  tree: readonly TreeNode[]
  posts: readonly PostSummary[]
  scope: ScopeKey | null
  query: TagQuery
  exactPathFilter?: string | null
}): TreeNode[] {
  const root = options.tree[0]
  if (!root || root.kind !== 'folder') return []
  let children = root.children
  if (options.scope) {
    const roots = scopeRootsFor(options.scope)
    children = children.filter((node) => roots.includes(node.path))
  }
  if (options.scope === 'diary') {
    const diaryRoot = children.find((node): node is Extract<TreeNode, { kind: 'folder' }> => (
      node.kind === 'folder' && node.path === 'diary'
    ))
    children = diaryRoot?.children ?? []
  }
  if (options.exactPathFilter) {
    const exactPath = options.exactPathFilter
    children = children
      .map((node) => filterByExactPath(node, exactPath))
      .filter((node): node is TreeNode => node !== null)
  }

  const { query } = options
  if (query.textTokens.length || query.includeAll.length || query.exclude.length || query.includeAny.length) {
    const postsByPath = new Map(options.posts.map((post) => [post.path, post]))
    const filterByQuery = (node: TreeNode): TreeNode | null => {
      if (node.kind === 'file') {
        const post = postsByPath.get(node.path)
        const doc = post
          ? { path: node.path, title: node.title, tags: post.tags, summary: post.summary }
          : { path: node.path, title: node.title, tags: [] as string[] }
        return matchesTagQuery(doc, query) ? node : null
      }
      const kids = node.children
        .map(filterByQuery)
        .filter((child): child is TreeNode => child !== null)
      return kids.length ? { ...node, children: kids } : null
    }
    children = children.map(filterByQuery).filter((node): node is TreeNode => node !== null)
  }
  return children
}

function filterByExactPath(node: TreeNode, exactPath: string): TreeNode | null {
  if (node.kind === 'file') return node.path === exactPath ? node : null
  const children = node.children
    .map((child) => filterByExactPath(child, exactPath))
    .filter((child): child is TreeNode => child !== null)
  return children.length ? { ...node, children } : null
}
