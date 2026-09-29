import { nextTick, onScopeDispose, watch, type Ref, type WatchStopHandle } from 'vue'
import { consumeLinkNavigation, linkNavigationIntent } from '../useLinkNavigation'

export interface LinkNavigationPane {
  revealAnchor(anchor: string, isCurrent?: () => boolean): boolean | Promise<boolean>
}

export interface LinkNavigationTab {
  path: string
  loading: boolean
  loadError: string | null
}

export function watchLinkNavigationHandoff(options: {
  activePath: Readonly<Ref<string | null>>
  activeTab: Readonly<Ref<LinkNavigationTab | null>>
  editorPane: Ref<LinkNavigationPane | null>
  readingPane: Ref<LinkNavigationPane | null>
  readingPaneReady: Readonly<Ref<boolean>>
  isReadMode: Readonly<Ref<boolean>>
  isOrdinaryPresentation: Readonly<Ref<boolean>>
}): WatchStopHandle {
  let trackedIntentId: number | null = null
  let enteredTarget = false

  const stop = watch(
    () => [
      linkNavigationIntent.value?.id,
      options.activePath.value,
      options.activeTab.value?.path,
      options.activeTab.value?.loading,
      options.activeTab.value?.loadError,
      options.editorPane.value,
      options.readingPane.value,
      options.readingPaneReady.value,
      options.isReadMode.value,
      options.isOrdinaryPresentation.value,
    ],
    async () => {
      const pending = linkNavigationIntent.value
      if (!pending) {
        trackedIntentId = null
        enteredTarget = false
        return
      }
      if (pending.id !== trackedIntentId) {
        trackedIntentId = pending.id
        enteredTarget = false
      }

      const activePath = options.activePath.value
      if (activePath === pending.path) enteredTarget = true
      else if (enteredTarget) {
        consumeLinkNavigation(pending.id)
        trackedIntentId = null
        enteredTarget = false
        return
      } else {
        // The normal openPost route transition has not reached its target yet.
        return
      }

      const tab = options.activeTab.value
      if (!tab || tab.path !== pending.path || tab.loading) return
      if (tab.loadError) {
        consumeLinkNavigation(pending.id)
        return
      }
      if (!options.isOrdinaryPresentation.value) {
        consumeLinkNavigation(pending.id)
        return
      }

      await nextTick()
      if (linkNavigationIntent.value?.id !== pending.id) return

      const currentTab = options.activeTab.value
      if (
        options.activePath.value !== pending.path
        || !currentTab
        || currentTab.path !== pending.path
        || currentTab.loading
      ) return
      if (currentTab.loadError || !options.isOrdinaryPresentation.value) {
        consumeLinkNavigation(pending.id)
        return
      }

      const expectedReadMode = options.isReadMode.value
      const isCurrent = () => {
        const latestTab = options.activeTab.value
        return linkNavigationIntent.value?.id === pending.id
          && options.activePath.value === pending.path
          && latestTab?.path === pending.path
          && !latestTab.loading
          && !latestTab.loadError
          && options.isReadMode.value === expectedReadMode
          && options.isOrdinaryPresentation.value
      }

      if (options.isReadMode.value) {
        if (!options.readingPaneReady.value) return
        const pane = options.readingPane.value
        if (!pane) return
        try {
          await pane.revealAnchor(pending.anchor, isCurrent)
        } catch {
          // Failed/missing targets are terminal for this one-shot intent.
        }
      } else {
        const pane = options.editorPane.value
        if (!pane) return
        try {
          await pane.revealAnchor(pending.anchor, isCurrent)
        } catch {
          // Failed/missing targets are terminal for this one-shot intent.
        }
      }

      if (linkNavigationIntent.value?.id === pending.id) consumeLinkNavigation(pending.id)
    },
    { flush: 'post' },
  )

  onScopeDispose(() => {
    const pending = linkNavigationIntent.value
    stop()
    if (pending) consumeLinkNavigation(pending.id)
  })
  return stop
}
