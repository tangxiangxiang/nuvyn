<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { NButton, NIcon, NInput, type InputInst } from 'naive-ui'
import { Search } from '@vicons/tabler'
import type { TreeNode, PostSummary } from '../../lib/api'
import { matchesTagQuery, parseTagQuery, type TagQuery } from '../../lib/tags'
import TreeRow from './TreeRow.vue'
import { useConfirm } from '../../composables/useConfirm'
import { usePrompt } from '../../composables/usePrompt'
import { useToast } from '../../composables/useToast'
import { blockedMessage } from '../../../shared/archiveProtocol'
import { createPost, createFolder as createFolderApi, patchPost, deletePost, renameFolder, deleteFolder, getRenameImpact } from '../../lib/api'
import { suggestSlug } from '../../lib/ai-api'
import { isSlugSegment, toLocalSlug } from '../../lib/slug'
import { useScopeFilter } from '../../composables/vault/useScopeFilter'
import { scopeRootsFor } from '../../../shared/scopeProtocol'
import { useArchiveNote } from '../../composables/vault/useArchiveNote'
import { getFallbackVaultFileChanges } from '../../composables/vault/context/fileChanges'
import { useOptionalVaultContext } from '../../composables/vault/context/useVaultContext'
import { useI18n } from '../../composables/useI18n'
import { useFileTreePreferences } from '../../composables/vault/useFileTreePreferences'
import { clearMetadataDraftForPath, updateMetadataDraftPath } from './metadataDraftStore'
import { classifyDiaryPath, isManagedDiaryPath } from '../../../shared/diaryProtocol'
import { NUVYN_BROWSER_STORAGE_KEYS, nuvynBoardDragMime, readDataTransfer, readStorageKey, writeStorageKey } from '../../technicalNamespace'

const props = withDefaults(defineProps<{
  tree: TreeNode[]
  posts?: PostSummary[]
  currentPath: string | null
  exactPathFilter?: string | null
  exactPathFilterLabel?: string | null
  exactPathFilterActionLabel?: string | null
}>(), {
  posts: () => [],
  exactPathFilter: null,
  exactPathFilterLabel: null,
  exactPathFilterActionLabel: null,
})
const emit = defineEmits<{
  select: [path: string]
  refresh: []
  // archive-note is self-contained inside FileTree: handler calls
  // patchPost + emit('refresh') + (optionally) emit('select'). VaultView
  // doesn't need to know. It remains a convenience workflow even though
  // ordinary move operations can also target archive/.
  'archive-note': [path: string]
  'export-pdf': [path: string]
  'open-history': [path: string]
  'clear-exact-path-filter': []
}>()

const { confirm } = useConfirm()
const { prompt } = usePrompt()
const { archive: archiveNote } = useArchiveNote()
const toast = useToast()
const { t } = useI18n()
const { compactFileTree } = useFileTreePreferences()
const vaultContext = useOptionalVaultContext()
const lifecycle = vaultContext?.lifecycle
const publishChange = vaultContext?.fileChanges.publish ?? getFallbackVaultFileChanges().publish
const searchInputRef = ref<InputInst | null>(null)
const fileTreeRootRef = ref<HTMLElement | null>(null)

// Presentation defense only. The server-side document mutation policy is the
// authority, but the tree should not offer an ordinary move into the reserved
// Diary namespace in the first place.
function blockDiaryDestination(path: string): boolean {
  if (classifyDiaryPath(path) === 'outside') return false
  toast.error(t('file_tree.diary_namespace_move_blocked'))
  return true
}

const STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.vaultExpandedPaths
const PATH_MIME = nuvynBoardDragMime('path')
const KIND_MIME = nuvynBoardDragMime('kind')
const expanded = ref<Set<string>>(new Set(loadExpanded()))

// Scope filter is owned by useScopeFilter (shared with the NavBar that
// renders the chips). We only read activeScope here — the filter is
// applied to topLevel below, and the chips live in the NavBar.
const { activeScope } = useScopeFilter()

async function suggestEnglishSlug(input: string, kind: 'file' | 'folder'): Promise<string> {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const local = toLocalSlug(trimmed)
  if (local && /^[\x00-\x7F]+$/.test(trimmed)) return local
  try {
    const out = await suggestSlug({ input: trimmed, kind })
    return out.slug
  } catch (e: any) {
    if (local) return local
    toast.error(t('file_tree.ai_slug_failed', { error: e.message ?? t('common.unknown_error') }))
    return trimmed
  }
}

// The server returns a single implicit root folder ("content", path "") whose
// children are the user's top-level folders. We don't surface that synthetic
// root in the UI — only its children are rendered.
const topLevel = computed<TreeNode[]>(() => {
  const root = props.tree[0]
  if (!root || root.kind !== 'folder') return []
  let children = root.children
  if (activeScope.value) {
    const roots = scopeRootsFor(activeScope.value)
    children = children.filter((c) => roots.includes(c.path))
  }
  // The exact-path constraint is a generic presentation projection. It has
  // higher priority than the user's text/tag query but never mutates that
  // query, so leaving the detail context restores the search verbatim.
  if (props.exactPathFilter) {
    children = children
      .map((child) => filterByExactPath(child, props.exactPathFilter!))
      .filter((node): node is TreeNode => node !== null)
  }
  // Rebuild the subtree so non-matching files are hidden while matching
  // ancestors remain visible. A matching folder keeps its complete
  // subtree. The filter runs through the shared `matchesTagQuery`
  // predicate, which means an empty query (no text tokens, no
  // includes, no excludes) matches every file and the tree is
  // returned unchanged.
  if (
    parsedQuery.value.textTokens.length > 0 ||
    parsedQuery.value.includeAll.length > 0 ||
    parsedQuery.value.exclude.length > 0 ||
    parsedQuery.value.includeAny.length > 0
  ) {
    children = children
      .map((c) => filterByQuery(c))
      .filter((n): n is TreeNode => n !== null)
  }
  return children
})

function filterByExactPath(node: TreeNode, exactPath: string): TreeNode | null {
  if (node.kind === 'file') return node.path === exactPath ? node : null
  const children = node.children
    .map((child) => filterByExactPath(child, exactPath))
    .filter((child): child is TreeNode => child !== null)
  return children.length > 0 ? { ...node, children } : null
}
// Only ambiguous display titles pay the cost of an always-visible path hint.
// Count across the complete tree, not the filtered result, so a search/filter
// cannot make an otherwise ambiguous title suddenly look unique.
const duplicateTitles = computed<Set<string>>(() => {
  const counts = new Map<string, number>()
  const walk = (node: TreeNode) => {
    if (node.kind === 'file') {
      const title = (node.title.trim() || node.name).toLocaleLowerCase()
      counts.set(title, (counts.get(title) ?? 0) + 1)
    } else node.children.forEach(walk)
  }
  props.tree.forEach(walk)
  return new Set([...counts].filter(([, count]) => count > 1).map(([title]) => title))
})

// VaultView owns the filter so it survives FileTree being unmounted while the
// user visits another side-panel view. It intentionally remains session-only.
const contentText = defineModel<string>('filter', { default: '' })

const effectiveQuery = computed(() => contentText.value.trim())
const exactPathFilterActive = computed(() => props.exactPathFilter !== null)
// Phase 1.1 fix: every FileTree search now flows through the shared
// query model — no separate legacy branch for plain-text queries.
// This guarantees three things:
//   (a) The text channel is AND-tokenized (`redis cache` → both
//       tokens must match) regardless of whether `#tags` are also
//       present.
//   (b) Text tokens never search the body summary, matching the
//       pre-Phase-1 substring scope exactly.
//   (c) Bare `#` produces an empty query, so the user sees the
//       full tree while they finish typing — no silent "filter
//       for literal #" branch that would empty the result list.
const parsedQuery = computed<TagQuery>(() => parseTagQuery(contentText.value))
// Lookup so `filterByQuery` can resolve a tree node's path to its
// `PostSummary` (and therefore to its tags) without a linear scan.
const postsByPath = computed<Map<string, PostSummary>>(
  () => new Map(props.posts.map((p) => [p.path, p])),
)

function filterByQuery(node: TreeNode): TreeNode | null {
  const query = parsedQuery.value
  if (node.kind === 'file') {
    const post = postsByPath.value.get(node.path)
    const doc = post
      ? { path: node.path, title: node.title, tags: post.tags, summary: post.summary }
      // Files we have no `PostSummary` for (e.g. just-created empty
      // notes still being snapshotted by the server) carry an empty
      // tag set so an `#xxx` query correctly excludes them. The
      // text channel still has path/title to match against.
      : { path: node.path, title: node.title, tags: [] as string[] }
    return matchesTagQuery(doc, query) ? node : null
  }
  // Folder: keep its complete subtree if any descendant file
  // matches. Mirrors the legacy "folder match keeps subtree"
  // behavior, just driven by the tag-aware predicate instead of
  // raw token substring.
  const kids = node.children
    .map((c) => filterByQuery(c))
    .filter((n): n is TreeNode => n !== null)
  if (kids.length === 0) return null
  return { ...node, children: kids }
}

// Per-file match annotation, derived by re-walking the already-filtered
// tree. Each text token is assigned to its first matching field in
// this order: title, filename, directory path. Tag tokens (`#xxx` /
// `-#xxx`) are NOT annotated — the tooltip is specifically about
// text-match fields (title/filename/directory), and a separate
// "matched in tags" annotation is Phase 3 territory. Folder matches
// are not annotated — a folder kept because the user typed its name
// is a scope expansion, not a "match", and adding a tooltip there
// would be noise. The derived map is empty when there are no text
// tokens, so TreeRow's `matchInfo?` prop stays unset and Vue strips
// the `title` attribute entirely.
export interface MatchInfo {
  name?: boolean
  path?: boolean
  title?: boolean
}
const matchedFields = computed<Map<string, MatchInfo>>(() => {
  if (exactPathFilterActive.value) return new Map()
  const tokens = parsedQuery.value.textTokens
  if (tokens.length === 0) return new Map()
  const m = new Map<string, MatchInfo>()
  const walk = (node: TreeNode) => {
    if (node.kind !== 'file') {
      for (const c of node.children) walk(c)
      return
    }
    const info: MatchInfo = {}
    const nameLc = node.name.toLocaleLowerCase()
    const titleLc = node.title.toLocaleLowerCase()
    const directoryLc = node.path.split('/').slice(0, -1).join('/').toLocaleLowerCase()
    for (const needle of tokens) {
      if (titleLc.includes(needle)) info.title = true
      else if (nameLc.includes(needle)) info.name = true
      else if (directoryLc.includes(needle)) info.path = true
    }
    if (info.path || info.name || info.title) m.set(node.path, info)
  }
  for (const n of topLevel.value) walk(n)
  return m
})

// When a search is active, force every folder in the *filtered* tree to
// be expanded so the user sees the matches without clicking through.
// We don't write to `expanded` itself — that set is persisted to
// localStorage and represents the user's deliberate collapse state. The
// search-time override is layered on top via `effectiveExpanded`, and
// disappears the moment the query clears, restoring the saved layout.
const searchForcedExpanded = computed<Set<string> | null>(() => {
  if (!effectiveQuery.value && !exactPathFilterActive.value) return null
  const set = new Set<string>()
  const walk = (n: TreeNode) => {
    if (n.kind !== 'folder') return
    set.add(n.path)
    for (const c of n.children) walk(c)
  }
  for (const n of topLevel.value) walk(n)
  return set
})
const effectiveExpanded = computed<Set<string>>(() => {
  const base = expanded.value
  const over = searchForcedExpanded.value
  if (!over) return base
  const u = new Set(base)
  for (const p of over) u.add(p)
  return u
})

type VisibleTreeItem = { node: TreeNode; parentKey: string | null }
const visibleItems = computed<VisibleTreeItem[]>(() => {
  const items: VisibleTreeItem[] = []
  const walk = (nodes: TreeNode[], parentKey: string | null) => {
    for (const node of nodes) {
      items.push({ node, parentKey })
      if (node.kind === 'folder' && effectiveExpanded.value.has(node.path)) {
        walk(node.children, nodeKey(node))
      }
    }
  }
  walk(topLevel.value, null)
  return items
})
const focusedNodeKey = ref<string | null>(null)

function nodeKey(node: Pick<TreeNode, 'kind' | 'path'>): string {
  return `${node.kind}:${node.path}`
}

function setFocused(path: string, kind: 'file' | 'folder', focusDom = false) {
  focusedNodeKey.value = `${kind}:${path}`
  if (focusDom) {
    nextTick(() => {
      const rows = document.querySelectorAll<HTMLElement>('.file-tree [data-tree-key]')
      Array.from(rows).find((row) => row.dataset.treeKey === focusedNodeKey.value)?.focus()
    })
  }
}

function onTreeKeydown(e: KeyboardEvent) {
  // The exact-path context action is a real button owned by the FileTree
  // header. Let its native Enter/Space activation reach the button instead
  // of treating the event as a treeitem command for the last focused row.
  const eventTarget = e.target instanceof HTMLElement ? e.target : null
  if (eventTarget?.closest('button, input, textarea, select, [contenteditable="true"]')) return

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchInputRef.value?.focus()
    return
  }
  const index = visibleItems.value.findIndex(({ node }) => nodeKey(node) === focusedNodeKey.value)
  if (index < 0) return
  const item = visibleItems.value[index]
  const node = item.node
  let target: VisibleTreeItem | undefined
  if (e.key === 'ArrowDown') target = visibleItems.value[index + 1]
  else if (e.key === 'ArrowUp') target = visibleItems.value[index - 1]
  else if (e.key === 'ArrowRight' && node.kind === 'folder') {
    if (!effectiveExpanded.value.has(node.path)) toggle(node.path)
    else target = visibleItems.value[index + 1]
  } else if (e.key === 'ArrowLeft') {
    if (node.kind === 'folder' && effectiveExpanded.value.has(node.path)) toggle(node.path)
    else if (item.parentKey) target = visibleItems.value.find(({ node: candidate }) => nodeKey(candidate) === item.parentKey)
  } else if (e.key === 'Enter') {
    if (node.kind === 'folder') toggle(node.path)
    else emit('select', node.path)
  } else if (e.key === 'F2') {
    void onRequestRename(node.path, node.kind)
  } else if (e.key === 'Delete') {
    void onDelete(node.path, node.kind)
  } else return
  e.preventDefault()
  e.stopPropagation()
  if (target) setFocused(target.node.path, target.node.kind, true)
}

watch([visibleItems, () => props.currentPath], ([items, currentPath]) => {
  if (focusedNodeKey.value && items.some(({ node }) => nodeKey(node) === focusedNodeKey.value)) return
  const current = items.find(({ node }) => node.kind === 'file' && node.path === currentPath)
  const fallback = current ?? items[0]
  focusedNodeKey.value = fallback ? nodeKey(fallback.node) : null
}, { immediate: true })

function clearContentText() {
  contentText.value = ''
}

function onQueryKeydown(e: KeyboardEvent) {
  // Esc inside the filter clears it but does not propagate, so
  // the vault's global Esc handler (which closes panels / tabs)
  // doesn't fire on the same keypress. Mirrors the same escape on
  // TagPanel's tag-filter input.
  if (e.key === 'Escape' && contentText.value) {
    e.stopPropagation()
    contentText.value = ''
  }
}

function loadExpanded(): string[] {
  try {
    const raw = readStorageKey(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : []
  } catch { return [] }
}
function saveExpanded() {
  writeStorageKey(STORAGE_KEY, JSON.stringify([...expanded.value]))
}

function containsFile(nodes: readonly TreeNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.kind === 'file' && node.path === path) return true
    if (node.kind === 'folder' && containsFile(node.children, path)) return true
  }
  return false
}

async function revealPath(path: string): Promise<boolean> {
  if (!containsFile(props.tree, path)) return false
  const segments = path.split('/')
  let ancestor = ''
  for (let i = 0; i < segments.length - 1; i++) {
    ancestor = ancestor ? `${ancestor}/${segments[i]}` : segments[i]
    expanded.value.add(ancestor)
  }
  expanded.value = new Set(expanded.value)
  saveExpanded()
  focusedNodeKey.value = `file:${path}`
  await nextTick()
  const rows = fileTreeRootRef.value?.querySelectorAll<HTMLElement>('[data-tree-key]') ?? []
  const row = Array.from(rows).find((candidate) => candidate.dataset.treeKey === `file:${path}`)
  if (!row) return false
  row.focus()
  row.scrollIntoView({ block: 'nearest' })
  return true
}

defineExpose({ revealPath })

function toggle(path: string) {
  if (expanded.value.has(path)) expanded.value.delete(path)
  else expanded.value.add(path)
  expanded.value = new Set(expanded.value)
  saveExpanded()
}

function remapExpandedFolder(fromPath: string, toPath: string): void {
  let changed = false
  const next = new Set<string>()
  for (const path of expanded.value) {
    if (path === fromPath || path.startsWith(`${fromPath}/`)) {
      next.add(`${toPath}${path.slice(fromPath.length)}`)
      changed = true
    } else next.add(path)
  }
  if (!changed) return
  expanded.value = next
  saveExpanded()
}

function remapFocusedNodeKey(
  key: string | null,
  fromPath: string,
  toPath: string,
  kind: 'file' | 'folder',
): string | null {
  if (!key) return key
  const separator = key.indexOf(':')
  if (separator === -1) return key
  const focusedKind = key.slice(0, separator)
  const focusedPath = key.slice(separator + 1)
  if (kind === 'file') {
    return focusedKind === 'file' && focusedPath === fromPath
      ? `file:${toPath}`
      : key
  }
  if (focusedPath !== fromPath && !focusedPath.startsWith(`${fromPath}/`)) return key
  return `${focusedKind}:${toPath}${focusedPath.slice(fromPath.length)}`
}

// Default-expand ancestors of currentPath. Archive can now contain
// classification folders, so the active archived note should be revealed too.
watch(() => props.currentPath, (p) => {
  if (!p) return
  const segs = p.split('/')
  const ancestors: string[] = []
  let acc = ''
  for (let i = 0; i < segs.length - 1; i++) {
    acc = acc ? `${acc}/${segs[i]}` : segs[i]
    ancestors.push(acc)
  }
  let changed = false
  for (const a of ancestors) if (!expanded.value.has(a)) { expanded.value.add(a); changed = true }
  if (changed) { expanded.value = new Set(expanded.value); saveExpanded() }
}, { immediate: true })

// --- drag on root (move to content root) ---
const isRootDropTarget = ref(false)
const rootDragDepth = ref(0)
function onRootDragEnter(e: DragEvent) { e.preventDefault(); rootDragDepth.value++; isRootDropTarget.value = true }
function onRootDragLeave() { rootDragDepth.value = Math.max(0, rootDragDepth.value - 1); if (rootDragDepth.value === 0) isRootDropTarget.value = false }
function onRootDragOver(e: DragEvent) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move' }
async function onRootDrop(e: DragEvent) {
  e.preventDefault()
  const src = readDataTransfer(e.dataTransfer, PATH_MIME)
  const srcKind = readDataTransfer(e.dataTransfer, KIND_MIME) === 'folder' ? 'folder' : 'file'
  isRootDropTarget.value = false
  rootDragDepth.value = 0
  if (!src) return
  if (srcKind === 'folder') {
    // Folder re-parenting is not currently a Nuvyn capability. TreeRow only
    // exposes file drags, but keep this guard for synthetic/custom payloads.
    toast.error(t('file_tree.move_failed', { error: 'folder move is not supported' }))
    return
  }
  // Reject moves of protected roots (the three top-level folders are part
  // of the vault protocol and cannot be re-parented). Archive descendants
  // are ordinary movable content.
  {
    const msg = blockedMessage(src, 'move', t)
    if (msg) { toast.error(msg); return }
  }
  if (isManagedDiaryPath(src)) {
    toast.error(t('file_tree.diary_identity_locked'))
    return
  }
  const filename = src.split('/').pop()!
  const targetPath = filename
  if (targetPath === src) return
  if (blockDiaryDestination(targetPath)) return
  try {
    const moved = lifecycle
      ? await lifecycle.renameFile(src, { targetPath })
      : await patchPost(src, { targetPath })
    updateMetadataDraftPath(src, moved.path)
    if (!lifecycle) emit('refresh')
    if (props.currentPath === src && !lifecycle) emit('select', moved.path)
    toast.info(t('file_tree.moved_root'))
  } catch (err: any) {
    toast.error(t('file_tree.move_failed', { error: err.message ?? t('common.unknown_error') }))
  }
}

// --- helpers ---
// findNode now accepts an optional `kind` filter. The reason: a file and a
// folder can legitimately share the same path string (e.g. `inbox/notes.md`
// and `inbox/notes/` both surface as path='inbox/notes' in the API), and
// buildTree sorts folders first. Without the filter, a path-only lookup
// would always resolve to the folder even when the user right-clicked the
// file — so renaming the file would silently rename the folder, deleting
// the file would attempt to delete the folder, and the move cycle check
// would never fire. Callers in this file pass the kind that was emitted
// from TreeRow alongside the path.
function findNode(nodes: TreeNode[], path: string, kind?: 'file' | 'folder'): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path && (kind === undefined || n.kind === kind)) return n
    if (n.kind === 'folder') {
      const found = findNode(n.children, path, kind)
      if (found) return found
    }
  }
  return null
}
function countDescendants(n: TreeNode): number {
  if (n.kind !== 'folder') return 0
  return n.children.reduce((acc, c) => acc + 1 + countDescendants(c), 0)
}
function filePaths(n: TreeNode): string[] {
  if (n.kind === 'file') return [n.path]
  return n.children.flatMap(filePaths)
}

// --- row event handlers ---
async function onSelect(p: string) { emit('select', p) }
async function onToggle(p: string) { toggle(p) }

async function onRename(oldPath: string, newName: string, kind: 'file' | 'folder') {
  const safeName = toLocalSlug(newName) || newName.trim()
  // Look up the node by *both* path and kind — see findNode for why path
  // alone is ambiguous. A user right-clicking `inbox/notes.md` while the
  // folder `inbox/notes/` also exists must rename the file, not the folder.
  const node = findNode(props.tree, oldPath, kind)
  if (!node) return
  if (isManagedDiaryPath(oldPath)) {
    toast.error(t('file_tree.diary_identity_locked'))
    return
  }
  {
    const msg = blockedMessage(oldPath, 'rename', t)
    if (msg) { toast.error(msg); return }
  }
  if (!isSlugSegment(safeName)) {
    toast.error(t('common.name_invalid'))
    return
  }
  const focusedBeforeRename = focusedNodeKey.value
  try {
    if (node.kind === 'folder') {
      const parent = oldPath.split('/').slice(0, -1).join('/')
      const newPath = parent ? `${parent}/${safeName}` : safeName
      let updateReferences = false
      let referencePaths: string[] = []
      try {
        const impact = await getRenameImpact(oldPath, true)
        referencePaths = impact.sources
        updateReferences = impact.count > 0
          ? await confirm(t('file_tree.rename_folder_refs', { count: impact.count }))
          : false
      } catch { /* advisory */ }
      const res = lifecycle
        ? await lifecycle.renameFolder(
            oldPath,
            newPath,
            filePaths(node),
            updateReferences,
            updateReferences ? referencePaths : [],
          )
        : updateReferences
          ? await renameFolder(oldPath, newPath, true)
          : await renameFolder(oldPath, newPath)
      remapExpandedFolder(oldPath, res.path)
      if (!lifecycle) {
        for (const updated of res.updatedReferences ?? []) {
          publishChange({ path: updated.path, kind: 'write', newRaw: updated.raw })
        }
      }
      toast.success(t('file_tree.renamed_count', { count: res.moved.length }))
      const remappedFocus = remapFocusedNodeKey(focusedBeforeRename, oldPath, res.path, 'folder')
      if (remappedFocus && remappedFocus !== focusedBeforeRename) {
        const separator = remappedFocus.indexOf(':')
        const focusedKind = remappedFocus.slice(0, separator)
        const focusedPath = remappedFocus.slice(separator + 1)
        if (focusedKind === 'file' || focusedKind === 'folder') {
          setFocused(focusedPath, focusedKind, true)
        }
      }
      for (const oldFilePath of filePaths(node)) {
        const nextFilePath = oldFilePath === oldPath
          ? res.path
          : `${res.path}/${oldFilePath.slice(oldPath.length + 1)}`
        updateMetadataDraftPath(oldFilePath, nextFilePath)
      }
    } else {
      const parent = oldPath.split('/').slice(0, -1).join('/')
      const newPath = parent ? `${parent}/${safeName}` : safeName
      if (blockDiaryDestination(newPath)) return
      let updateReferences = false
      let referencePaths: string[] = []
      try {
        const impact = await getRenameImpact(oldPath)
        referencePaths = impact.sources
        updateReferences = impact.count > 0
          ? await confirm(t('file_tree.rename_file_refs', { count: impact.count }))
          : false
      } catch { /* impact preview is advisory; renaming still works */ }
      const body = updateReferences ? { name: safeName, updateReferences: true } : { name: safeName }
      const renamed = lifecycle
        ? await lifecycle.renameFile(oldPath, body, updateReferences ? referencePaths : [])
        : await patchPost(oldPath, body)
      const remappedFocus = remapFocusedNodeKey(focusedBeforeRename, oldPath, renamed.path, 'file')
      if (remappedFocus && remappedFocus !== focusedBeforeRename) {
        setFocused(renamed.path, 'file', true)
      }
      if (!lifecycle) {
        for (const updated of renamed.updatedReferences ?? []) {
          if (updated.path !== renamed.path) publishChange({ path: updated.path, kind: 'write', newRaw: updated.raw })
        }
      }
      updateMetadataDraftPath(oldPath, node.kind === 'file' ? renamed.path : oldPath)
    }
    if (!lifecycle) emit('refresh')
  } catch (e: any) {
    toast.error(t('file_tree.rename_failed', { error: e.message }))
  }
}

async function onRequestRename(oldPath: string, kind: 'file' | 'folder') {
  const node = findNode(props.tree, oldPath, kind)
  if (!node) return
  if (isManagedDiaryPath(oldPath)) {
    toast.error(t('file_tree.diary_identity_locked'))
    return
  }
  {
    const msg = blockedMessage(oldPath, 'rename', t)
    if (msg) { toast.error(msg); return }
  }
  const title = await prompt({
    title: t(kind === 'file' ? 'file_tree.rename_file_prompt' : 'file_tree.rename_folder_prompt', { name: node.name }),
    placeholder: t('file_tree.name_placeholder'),
    initial: node.name,
    actionLabel: '✧',
    actionTitle: t('file_tree.translate_slug'),
    transform: async (value) => suggestEnglishSlug(value, kind),
  })
  if (!title) return
  await onRename(oldPath, title, kind)
}

async function onDelete(p: string, kind: 'file' | 'folder') {
  // Same disambiguation as onRename — see findNode. A path-only lookup
  // would resolve a delete on `inbox/notes` to whichever node appears
  // first in the tree (the folder), and the wrong entity would be
  // deleted (or a confirm dialog would be shown for the wrong target).
  const node = findNode(props.tree, p, kind)
  if (!node) return
  {
    const msg = blockedMessage(p, 'delete', t)
    if (msg) { toast.error(msg); return }
  }
  const count = node.kind === 'folder' ? countDescendants(node) + 1 : 1
  const ok = await confirm(
    node.kind === 'folder'
      ? t('file_tree.delete_folder_confirm_drafts', { name: node.name, count: count - 1 })
      : t('file_tree.delete_file_confirm_drafts', { name: node.name }),
  )
  if (!ok) return
  // Capture discard authority synchronously at the user's confirmation
  // boundary, before lifecycle waits on any save or file mutation barrier.
  const draftConfirmations = lifecycle?.captureDraftDeleteConfirmations(
    node.kind === 'folder' ? filePaths(node) : [p],
  ) ?? []
  try {
    if (node.kind === 'folder') {
      if (lifecycle) {
        await lifecycle.deleteFolder(
          p,
          filePaths(node),
          { draftPolicy: 'discard-confirmed', draftConfirmations },
        )
      }
      else await deleteFolder(p, true)
    } else if (lifecycle) {
      await lifecycle.deleteFile(p, {
        draftPolicy: 'discard-confirmed',
        draftConfirmations,
      })
    }
    else await deletePost(p)
    for (const deletedPath of node.kind === 'folder' ? filePaths(node) : [p]) {
      clearMetadataDraftForPath(deletedPath)
    }
    if (!lifecycle) emit('refresh')
  } catch (e: any) { toast.error(t('file_tree.delete_failed', { error: e.message })) }
}

async function onMove(srcPath: string, targetFolder: string, srcKind: 'file' | 'folder') {
  if (isManagedDiaryPath(srcPath)) {
    toast.error(t('file_tree.diary_identity_locked'))
    return
  }
  {
    const msg = blockedMessage(srcPath, 'move', t)
    if (msg) { toast.error(msg); return }
  }
  if (srcKind === 'folder') {
    // Folder re-parenting is not currently a Nuvyn capability. This remains
    // a defensive backstop even though normal UI folder rows are not draggable.
    toast.error(t('file_tree.move_failed', { error: 'folder move is not supported' }))
    return
  }
  const filename = srcPath.split('/').pop()!
  const newPath = targetFolder ? `${targetFolder}/${filename}` : filename
  if (newPath === srcPath) return
  if (blockDiaryDestination(newPath)) return
  // Cycle check — kind-aware lookup. Without the kind filter, dragging a
  // file that shares a name with a folder would never trigger this
  // guard even if the path happened to also be an ancestor of the
  // target, because findNode would return null for the file but the
  // guard only fires when srcNode is a folder. With the kind, the
  // check runs against the actual source entity.
  const srcNode = findNode(props.tree, srcPath, srcKind)
  if (srcNode?.kind === 'folder' && (newPath === srcPath || newPath.startsWith(srcPath + '/'))) {
    toast.error(t('file_tree.move_into_self'))
    return
  }
  try {
    const moved = lifecycle
      ? await lifecycle.renameFile(srcPath, { targetPath: newPath })
      : await patchPost(srcPath, { targetPath: newPath })
    updateMetadataDraftPath(srcPath, moved.path)
    if (!lifecycle) emit('refresh')
    if (props.currentPath === srcPath && !lifecycle) emit('select', moved.path)
  } catch (e: any) {
    toast.error(t('file_tree.move_failed', { error: e.message ?? t('common.unknown_error') }))
  }
}

// Archive handler. Distinct from onMove: this is the explicit product action
// of archiving a finished note from inbox/ or literature/ straight into the
// archive/ root. Ordinary move operations can also target archive descendants;
// this action remains the one-click workflow for the default root target.
async function onArchiveNote(path: string) {
  const movedPath = await archiveNote(path)
  if (!movedPath) return
  if (!lifecycle) {
    emit('refresh')
    if (props.currentPath === path) emit('select', movedPath)
  }
  updateMetadataDraftPath(path, movedPath)
  await revealPath(movedPath)
}

async function onCreateIn(folder: string, kind: 'file' | 'folder') {
  if (classifyDiaryPath(folder) !== 'outside') {
    toast.error(t('file_tree.diary_generic_create_disabled'))
    return
  }
  {
    const msg = blockedMessage(folder, kind === 'file' ? 'create-file' : 'create-folder', t)
    if (msg) { toast.error(msg); return }
  }
  let translatedFromTitle = ''
  let translatedSlug = ''
  const title = await prompt({
    title: t(kind === 'file' ? 'file_tree.create_file_prompt' : 'file_tree.create_folder_prompt', { folder: folder || 'inbox' }),
    placeholder: t('file_tree.name_placeholder'),
    actionLabel: '✧',
    actionTitle: t('file_tree.translate_slug'),
    transform: async (value) => {
      const sourceTitle = value.trim()
      const slug = await suggestEnglishSlug(value, kind)
      translatedFromTitle = sourceTitle
      translatedSlug = slug
      return slug
    },
  })
  if (!title) return
  const name = toLocalSlug(title)
  if (!name || !isSlugSegment(name)) {
    toast.error(t('common.name_invalid'))
    return
  }
  const path = folder ? `${folder}/${name}` : name
  const metadataTitle = title === translatedSlug && translatedFromTitle
    ? translatedFromTitle
    : title
  try {
    if (kind === 'file') {
      if (lifecycle) await lifecycle.createFile({ path, title: metadataTitle })
      else {
        await createPost({ path, title: metadataTitle })
        publishChange({ path, kind: 'write', source: 'editor-lifecycle' })
      }
    }
    else if (lifecycle) await lifecycle.createFolder(path)
    else await createFolderApi(path)
    expanded.value.add(folder)
    expanded.value = new Set(expanded.value)
    saveExpanded()
    if (!lifecycle) emit('refresh')
  } catch (e: any) { toast.error(t('common.create_failed', { error: e.message })) }
}
</script>

<template>
  <aside
    ref="fileTreeRootRef"
    class="file-tree"
    :aria-label="t('file_tree.label')"
    :class="{ 'drop-target-root': isRootDropTarget }"
    @dragenter="onRootDragEnter"
    @dragleave="onRootDragLeave"
    @dragover="onRootDragOver"
    @drop="onRootDrop"
    @keydown="onTreeKeydown"
  >
    <header>
      <!-- Filters by title, filename, and directory path. Matching is
           case-insensitive and multiple tokens compose with AND.
      -->
      <div class="search">
        <NIcon class="search-icon" aria-hidden="true"><Search /></NIcon>
        <NInput
          ref="searchInputRef"
          v-model:value="contentText"
          class="search-input-control"
          size="small"
          :bordered="false"
          type="text"
          :placeholder="t('file_tree.search')"
          :input-props="{ class: 'search-input', 'aria-label': t('file_tree.search') }"
          @keydown="onQueryKeydown"
        />
        <NButton
          v-if="contentText"
          attr-type="button"
          text
          :bordered="false"
          class="search-clear-x"
          :title="t('file_tree.clear_search')"
          :aria-label="t('file_tree.clear_search')"
          @click="clearContentText"
        >×</NButton>
      </div>
    </header>
    <ul v-if="topLevel.length" class="tree" role="tree">
      <TreeRow
        v-for="node in topLevel"
        :key="nodeKey(node)"
        :node="node"
        :depth="0"
        :current-path="currentPath"
        :focused-node-key="focusedNodeKey"
        :expanded-set="effectiveExpanded"
        :matched-fields="matchedFields"
        :search-active="Boolean(effectiveQuery) && !exactPathFilterActive"
        :compact="compactFileTree"
        :duplicate-titles="duplicateTitles"
        @select="onSelect"
        @toggle="onToggle"
        @rename="onRename"
        @request-rename="onRequestRename"
        @delete="onDelete"
        @move="onMove"
        @create-in="onCreateIn"
        @archive-note="onArchiveNote"
        @export-pdf="(path) => emit('export-pdf', path)"
        @open-history="(path) => emit('open-history', path)"
        @focus="setFocused"
      />
    </ul>
    <p v-else-if="effectiveQuery && !exactPathFilterActive" class="empty">{{ t('file_tree.no_query_match', { query: effectiveQuery }) }}</p>
    <p v-else class="empty">{{ t('file_tree.empty') }}</p>
  </aside>
</template>
