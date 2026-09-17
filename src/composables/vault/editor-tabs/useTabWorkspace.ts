import { computed, ref, toRaw } from 'vue'
import { useRouter } from 'vue-router'
import { getPost, getTree, listPosts, type PostSummary, type TreeNode } from '../../../lib/api'
import { disposeMarkdownModel, renameMarkdownModel } from '../../../components/vault/monacoModelRegistry'
import type { Tab } from '../../../components/vault/tabs'
import { makeEmptyTab, pathToUrl, TAB_HARD_LIMIT, TAB_SOFT_LIMIT } from './tabState'
import { useI18n } from '../../useI18n'
import {
  applyPostSummaryToWorkspace,
  createLocalPostPatchTracker,
} from './workspacePostSummary'

export function requiresCloseConfirmation(tab: Tab): boolean {
  return tab.raw !== tab.originalRaw
    || tab.revision !== tab.savedRevision
    || tab.savingRevision !== null
    || tab.saveStatus === 'external'
    || tab.externalRaw != null
    || ['error', 'offline'].includes(tab.saveStatus)
}

export function useTabWorkspace(options: {
  confirm: (message: string) => Promise<boolean>
  toastError: (message: string) => void
  toastInfo: (message: string) => void
  /**
   * Synchronous session persist. Called after every close / rename /
   * restore-failure that mutates `tabs.value`, so a refresh before
   * the debounce flushes the watcher cannot resurrect a closed tab.
   * Optional — callers can bind it later via the `setPersist`
   * returned in the API.
   */
  persist?: () => void
}) {
  const { t } = useI18n()
  const router = useRouter()
  const tree = ref<TreeNode[]>([])
  // Tree state is shared by FileTree and the D3.2 Diary projection. Keep
  // loading/error separate from the data so a failed refresh is never
  // represented as an empty calendar.
  const treeLoading = ref(true)
  const treeError = ref<string | null>(null)
  const posts = ref<PostSummary[]>([])
  const tabs = ref<Tab[]>([])
  const activePath = ref<string | null>(null)
  let refreshRequestId = 0
  const localPostPatches = createLocalPostPatchTracker()
  // The workspace holds an internal mutable slot for the persister.
  // Callers can swap it later (see `setPersist` in the API) — needed
  // because `useTabPersistence` reads `tabs` / `activePath` after the
  // workspace has constructed them, and the persister depends on
  // those refs.
  let persistRef: (() => void) | undefined = options.persist

  const activeTab = computed<Tab | null>(
    () => tabs.value.find((tab) => tab.path === activePath.value) ?? null,
  )
  const isDirty = computed(() =>
    activeTab.value ? activeTab.value.raw !== activeTab.value.originalRaw : false,
  )
  const activeSize = computed(() => {
    const path = activePath.value
    if (!path) return 0
    return posts.value.find((post) => post.path === path)?.size ?? activeTab.value?.raw.length ?? 0
  })

  function navigateTo(path: string | null) {
    void router.replace(path ? pathToUrl(path) : '/vault')
  }

  /** Persist immediately. Best-effort — if persist is not bound
   *  (e.g. unit tests that don't care), this is a no-op. */
  function flushPersist(): void {
    persistRef?.()
  }

  function setPersist(persist: () => void): void {
    persistRef = persist
  }

  async function refresh() {
    const requestId = ++refreshRequestId
    const startedAtPatchSeq = localPostPatches.currentSeq()
    treeLoading.value = true
    treeError.value = null
    try {
      const [nextTree, nextPosts] = await Promise.all([getTree(), listPosts()])
      if (requestId !== refreshRequestId) return
      let mergedTree = nextTree
      let mergedPosts = nextPosts
      for (const patch of localPostPatches.after(startedAtPatchSeq)) {
        const merged = applyPostSummaryToWorkspace(mergedTree, mergedPosts, patch.post)
        mergedTree = merged.tree
        mergedPosts = merged.posts
      }
      tree.value = mergedTree
      posts.value = mergedPosts
      localPostPatches.settleThrough(startedAtPatchSeq)
    } catch (error) {
      if (requestId === refreshRequestId) {
        treeError.value = error instanceof Error && error.message
          ? error.message
          : String(error)
      }
      throw error
    } finally {
      if (requestId === refreshRequestId) treeLoading.value = false
    }
  }

  function applyPostSummary(post: PostSummary): void {
    const snapshot = localPostPatches.record(post).post
    const next = applyPostSummaryToWorkspace(tree.value, posts.value, snapshot)
    tree.value = next.tree
    posts.value = next.posts
    const tab = tabs.value.find((candidate) => candidate.path === post.path)
    if (tab) tab.title = post.title
  }

  /**
   * Find the reactive proxy for a plain tab object inside `tabs.value`.
   * Vue's `reactive()` wraps array elements in proxies on push, so
   * writes must go through the proxy to fire effect notifications.
   * Plain-object writes bypass the proxy `set` trap and silently
   * miss downstream computed recomputations (workspaceTabs, strip
   * title, save status, etc).
   *
   * The plain object is what we hold across `await getPost(...)` —
   * comparing with `===` against stored elements doesn't work because
   * the array stores proxies, so we unwrap with `toRaw` to check
   * membership. Returns null when the tab has been spliced from the
   * array — the caller must NOT resurrect it.
   */
  function liveTabFor(plainTab: Tab): Tab | null {
    const live = tabs.value.find((candidate) => toRaw(candidate) === plainTab)
    return live ?? null
  }

  async function openPost(path: string, openOptions: { refresh?: boolean } = {}) {
    const existing = tabs.value.find((tab) => tab.path === path)
    if (existing) {
      activePath.value = path
      navigateTo(path)
      return
    }
    if (tabs.value.length >= TAB_HARD_LIMIT) {
      options.toastError(t('editor.tab_limit', { count: TAB_HARD_LIMIT }))
      return
    }
    if (tabs.value.length >= TAB_SOFT_LIMIT) {
      options.toastInfo(t('editor.many_tabs'))
    }
    const plainTab = makeEmptyTab(path)
    tabs.value.push(plainTab)
    activePath.value = path
    navigateTo(path)
    try {
      const post = await getPost(path)
      // Race guard: the user may have closed this tab while getPost
      // was in flight. If so, drop the populated data — the watcher
      // debounce will not have caught this yet, so we also persist
      // synchronously. We compare against the plain object identity,
      // not a Proxy field read, because Vue wraps array elements in
      // a Proxy only on read.
      const live = liveTabFor(plainTab)
      if (!live) {
        flushPersist()
        return
      }
      // Must go through the proxy so dependent computeds recompute.
      live.raw = post.raw
      live.originalRaw = post.raw
      live.documentId = post.metadata?.id ?? null
      live.title = post.metadata?.title || (post.frontmatter.title as string) || path
      live.serverMtime = post.mtime
      live.loading = false
      live.loadError = null
    } catch (error) {
      const live = liveTabFor(plainTab)
      if (!live) {
        flushPersist()
        return
      }
      live.loadError = (error as Error).message
      live.loading = false
    }
    flushPersist()
    if (openOptions.refresh !== false) await refresh()
  }

  async function restoreOneTab(path: string): Promise<boolean> {
    if (tabs.value.find((tab) => tab.path === path)) return true
    const plainTab = makeEmptyTab(path)
    tabs.value.push(plainTab)
    flushPersist()
    try {
      const post = await getPost(path)
      // Race guard: if the user closed this tab while the request was
      // pending, the plainTab has already been spliced from the
      // array. Don't resurrect it. If a NEW tab for the same path
      // has since been opened (e.g. via the file tree), the restore
      // is a no-op — the new tab stands on its own and the missing
      // toast must NOT fire for it.
      const live = liveTabFor(plainTab)
      if (!live) {
        flushPersist()
        return tabs.value.some((candidate) => candidate.path === path)
      }
      // Writes go through the reactive Proxy so dependent computeds
      // (workspaceTabs, EditorTabs re-render) actually recompute.
      live.raw = post.raw
      live.originalRaw = post.raw
      live.documentId = post.metadata?.id ?? null
      live.title = post.metadata?.title || (post.frontmatter.title as string) || path
      live.serverMtime = post.mtime
      live.loading = false
      live.loadError = null
      flushPersist()
      return true
    } catch {
      // Failure branch must NOT splice a same-path tab opened by the
      // user in the meantime — that would silently discard any
      // local edits. Compare by plain-object identity, falling back
      // to path-based membership only when our own placeholder is
      // still in the array.
      const live = liveTabFor(plainTab)
      if (live) {
        const index = tabs.value.findIndex(
          (candidate) => toRaw(candidate) === plainTab,
        )
        if (index !== -1) tabs.value.splice(index, 1)
      }
      flushPersist()
      // If a same-path tab is now open (e.g. the user reopened it
      // while our restore was in flight), the restore failure is a
      // no-op for the user — don't report "file missing" for a tab
      // they can see and edit.
      return tabs.value.some((candidate) => candidate.path === path)
    }
  }

  async function closeTab(path: string, closeOptions?: { skipDirtyCheck?: boolean }): Promise<boolean> {
    const index = tabs.value.findIndex((tab) => tab.path === path)
    if (index === -1) return true
    const tab = tabs.value[index]
    if (!closeOptions?.skipDirtyCheck && requiresCloseConfirmation(tab)) {
      const ok = await options.confirm(t('editor.discard_one', { path: tab.path }))
      if (!ok) return false
    }
    tabs.value.splice(index, 1)
    disposeMarkdownModel(path)
    if (activePath.value === path) {
      const next = tabs.value[index] ?? tabs.value[index - 1] ?? null
      activePath.value = next ? next.path : null
      navigateTo(activePath.value)
    }
    flushPersist()
    return true
  }

  function validClosePaths(paths: string[]): string[] {
    return paths.filter((path) => tabs.value.some((tab) => tab.path === path))
  }

  async function confirmCloseMany(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return true
    const valid = validClosePaths(paths)
    if (valid.length === 0) return true
    const dirty = valid.filter((path) => {
      const tab = tabs.value.find((candidate) => candidate.path === path)
      return tab && requiresCloseConfirmation(tab)
    })
    if (dirty.length === 0) return true
    return options.confirm(
      dirty.length === 1
        ? t('editor.discard_one', { path: dirty[0] })
        : t('editor.discard_many', { count: dirty.length }),
    )
  }

  function closeManyConfirmed(paths: string[]): void {
    const valid = paths.filter((path) => tabs.value.some((tab) => tab.path === path))
    if (valid.length === 0) return
    const activeIndex = tabs.value.findIndex((tab) => tab.path === activePath.value)
    const closesActive = activePath.value !== null && valid.includes(activePath.value)
    const sorted = [...valid].sort((a, b) => {
      const aIndex = tabs.value.findIndex((tab) => tab.path === a)
      const bIndex = tabs.value.findIndex((tab) => tab.path === b)
      return bIndex - aIndex
    })
    for (const path of sorted) {
      const index = tabs.value.findIndex((tab) => tab.path === path)
      if (index !== -1) tabs.value.splice(index, 1)
      disposeMarkdownModel(path)
    }
    if (closesActive) {
      const next = tabs.value[activeIndex] ?? tabs.value[activeIndex - 1] ?? null
      activePath.value = next?.path ?? null
      navigateTo(activePath.value)
    }
    flushPersist()
  }

  async function closeMany(paths: string[]): Promise<boolean> {
    const confirmed = await confirmCloseMany(paths)
    if (!confirmed) return false
    closeManyConfirmed(paths)
    return true
  }

  function selectTab(path: string) {
    if (path === activePath.value) return
    const tab = tabs.value.find((candidate) => candidate.path === path)
    if (!tab) return
    activePath.value = path
    navigateTo(path)
  }

  function reorderTabs(paths: readonly string[]): boolean {
    if (paths.length !== tabs.value.length || new Set(paths).size !== paths.length) return false
    const byPath = new Map(tabs.value.map((tab) => [tab.path, tab]))
    if (paths.some((path) => !byPath.has(path))) return false
    if (paths.every((path, index) => tabs.value[index]?.path === path)) return false
    tabs.value = paths.map((path) => byPath.get(path)!)
    flushPersist()
    return true
  }

  function renameOpenDocuments(mappings: ReadonlyArray<{ from: string; to: string }>): void {
    const bySource = new Map(
      mappings.filter(({ from, to }) => from && to && from !== to).map((item) => [item.from, item.to]),
    )
    if (bySource.size === 0) return
    for (const [fromPath, nextPath] of bySource) {
      const source = tabs.value.find((tab) => tab.path === fromPath)
      if (!source) continue
      const duplicateIndex = tabs.value.findIndex((tab) => tab !== source && tab.path === nextPath)
      if (duplicateIndex !== -1) tabs.value.splice(duplicateIndex, 1)
      renameMarkdownModel(fromPath, nextPath)
      source.path = nextPath
    }
    // Replace the array identity so shallow persistence/watch consumers record
    // non-active tab migrations too.
    tabs.value = [...tabs.value]
    const nextActive = activePath.value ? bySource.get(activePath.value) : null
    if (nextActive) {
      activePath.value = nextActive
      navigateTo(nextActive)
    }
    flushPersist()
  }

  function removeOpenDocuments(paths: readonly string[]): void {
    closeManyConfirmed([...new Set(paths)])
  }

  return {
    tree,
    treeLoading,
    treeError,
    posts,
    tabs,
    activePath,
    activeTab,
    isDirty,
    activeSize,
    refresh,
    applyPostSummary,
    openPost,
    restoreOneTab,
    closeTab,
    closeMany,
    confirmCloseMany,
    closeManyConfirmed,
    selectTab,
    reorderTabs,
    renameOpenDocuments,
    removeOpenDocuments,
    navigateTo,
    setPersist,
  }
}
