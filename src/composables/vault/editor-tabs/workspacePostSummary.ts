import type { PostSummary, TreeNode } from '../../../lib/api'

export interface LocalPostPatch {
  seq: number
  post: PostSummary
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b)
}

export function clonePostSummary(post: PostSummary): PostSummary {
  return {
    ...post,
    tags: [...post.tags],
    updatedReferences: post.updatedReferences?.map((reference) => ({ ...reference })),
  }
}

export function createLocalPostPatchTracker() {
  let seq = 0
  const patches = new Map<string, LocalPostPatch>()
  return {
    currentSeq(): number {
      return seq
    },
    record(post: PostSummary): LocalPostPatch {
      const patch = { seq: ++seq, post: clonePostSummary(post) }
      patches.set(post.path, patch)
      return patch
    },
    after(startedAtSeq: number): LocalPostPatch[] {
      return [...patches.values()]
        .filter((patch) => patch.seq > startedAtSeq)
        .sort((a, b) => a.seq - b.seq)
    },
    settleThrough(startedAtSeq: number): void {
      for (const [path, patch] of patches) {
        if (patch.seq <= startedAtSeq) patches.delete(path)
      }
    },
    pendingCount(): number {
      return patches.size
    },
  }
}

export function upsertPostSummary(
  posts: readonly PostSummary[],
  post: PostSummary,
): PostSummary[] {
  const replacement = clonePostSummary(post)
  return [
    ...posts.filter((item) => item.path !== post.path),
    replacement,
  ].sort((a, b) => naturalCompare(a.path, b.path))
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return naturalCompare(a.name, b.name)
  })
}

function fileNode(post: PostSummary): TreeNode {
  return {
    kind: 'file',
    path: post.path,
    name: post.path.split('/').pop() ?? post.path,
    title: post.title,
    mtime: post.mtime,
  }
}

function replaceExistingFile(
  nodes: readonly TreeNode[],
  post: PostSummary,
  state: { inserted: boolean },
): TreeNode[] {
  let changed = false
  const next: TreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'file' && node.path === post.path) {
      changed = true
      if (!state.inserted) {
        next.push(fileNode(post))
        state.inserted = true
      }
      continue
    }
    if (node.kind === 'folder') {
      const children = replaceExistingFile(node.children, post, state)
      if (children !== node.children) {
        changed = true
        next.push({ ...node, children })
      } else {
        next.push(node)
      }
      continue
    }
    next.push(node)
  }
  return changed ? sortTreeNodes(next) : nodes as TreeNode[]
}

function createFolderChain(
  parentPath: string,
  parts: readonly string[],
  file: TreeNode,
): TreeNode {
  const [name, ...rest] = parts
  const folderPath = parentPath ? `${parentPath}/${name}` : name!
  return {
    kind: 'folder',
    name: name!,
    path: folderPath,
    children: rest.length > 0
      ? [createFolderChain(folderPath, rest, file)]
      : [file],
  }
}

function insertIntoFolder(
  folder: Extract<TreeNode, { kind: 'folder' }>,
  parentParts: readonly string[],
  file: TreeNode,
): Extract<TreeNode, { kind: 'folder' }> {
  if (parentParts.length === 0) {
    return { ...folder, children: sortTreeNodes([...folder.children, file]) }
  }
  const [name, ...rest] = parentParts
  const expectedPath = folder.path ? `${folder.path}/${name}` : name!
  const index = folder.children.findIndex(
    (node) => node.kind === 'folder' && node.path === expectedPath,
  )
  const children = [...folder.children]
  if (index === -1) {
    children.push(createFolderChain(folder.path, parentParts, file))
  } else {
    const child = children[index] as Extract<TreeNode, { kind: 'folder' }>
    children[index] = insertIntoFolder(child, rest, file)
  }
  return { ...folder, children: sortTreeNodes(children) }
}

export function upsertTreeFile(
  tree: readonly TreeNode[],
  post: PostSummary,
): TreeNode[] {
  const state = { inserted: false }
  const replaced = replaceExistingFile(tree, post, state)
  if (state.inserted) return replaced

  const file = fileNode(post)
  const parentParts = post.path.split('/').slice(0, -1)
  const rootIndex = replaced.findIndex(
    (node) => node.kind === 'folder' && node.path === '',
  )
  if (rootIndex === -1) {
    const child = parentParts.length > 0 ? createFolderChain('', parentParts, file) : file
    return sortTreeNodes([...replaced, {
      kind: 'folder',
      name: 'content',
      path: '',
      children: [child],
    }])
  }

  const next = [...replaced]
  next[rootIndex] = insertIntoFolder(
    next[rootIndex] as Extract<TreeNode, { kind: 'folder' }>,
    parentParts,
    file,
  )
  return next
}

export function applyPostSummaryToWorkspace(
  tree: readonly TreeNode[],
  posts: readonly PostSummary[],
  post: PostSummary,
): { tree: TreeNode[]; posts: PostSummary[] } {
  return {
    tree: upsertTreeFile(tree, post),
    posts: upsertPostSummary(posts, post),
  }
}
