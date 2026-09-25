import { nextTick, watch, type Ref, type WatchStopHandle } from 'vue'
import {
  consumeSearchReveal,
  searchRevealIntent,
} from '../useSearchReveal'

export interface SearchRevealEditor {
  revealText(text: string): boolean
}

export interface SearchRevealTab {
  path: string
  loading: boolean
  loadError: string | null
}

export function watchSearchRevealHandoff(options: {
  activePath: Readonly<Ref<string | null>>
  activeTab: Readonly<Ref<SearchRevealTab | null>>
  editorPane: Ref<SearchRevealEditor | null>
  isReadMode: Readonly<Ref<boolean>>
  isOrdinaryPresentation: Readonly<Ref<boolean>>
}): WatchStopHandle {
  return watch(
    () => [
      searchRevealIntent.value?.id,
      options.activePath.value,
      options.activeTab.value?.path,
      options.activeTab.value?.loading,
      options.activeTab.value?.loadError,
      options.editorPane.value,
      options.isReadMode.value,
      options.isOrdinaryPresentation.value,
    ],
    async () => {
      const pending = searchRevealIntent.value
      if (!pending || options.activePath.value !== pending.path) return

      const tab = options.activeTab.value
      if (!tab || tab.path !== pending.path || tab.loading) return
      if (tab.loadError) {
        consumeSearchReveal(pending.id)
        return
      }

      // Reveal is an editor-only presentation intent. Consume it once the
      // target document has loaded in Read Mode or another non-document view.
      if (options.isReadMode.value || !options.isOrdinaryPresentation.value) {
        consumeSearchReveal(pending.id)
        return
      }

      await nextTick()
      if (searchRevealIntent.value?.id !== pending.id) return

      const currentTab = options.activeTab.value
      if (options.activePath.value !== pending.path || !currentTab || currentTab.path !== pending.path) return
      if (currentTab.loading) return
      if (currentTab.loadError || options.isReadMode.value || !options.isOrdinaryPresentation.value) {
        consumeSearchReveal(pending.id)
        return
      }

      const editor = options.editorPane.value
      if (!editor) return
      editor.revealText(pending.text)
      consumeSearchReveal(pending.id)
    },
    { flush: 'post' },
  )
}
