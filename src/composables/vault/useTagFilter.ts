// Tag filter state. Pure view-state: which tags (if any) the user has
// selected from the TagPanel. Multi-select with OR semantics — `#a ∪ #b`
// shows posts tagged with either.
//
// The composable also owns the side-effect that selecting a tag must
// surface the Files panel — the user picks a tag in the TagPanel
// (visible when activePanel === 'tags'), and the selection should
// bring the file tree back into view so the filtered files can be
// browsed.
//
// The activePanel ref is taken by ref (not getter) so the closure can
// mutate it directly. This makes the coupling explicit in the
// constructor signature — the only thing that can flip activePanel
// from a tag click is toggleTag.

import { computed, ref, type Ref } from 'vue'
import type { ActivePanel } from './useVaultLayout'

export function useTagFilter(opts: {
  activePanel: Ref<ActivePanel>
}) {
  // Set instead of a single ref: the user can pin multiple tags and see
  // the union. We expose both a Set and a derived array so consumers can
  // pick the shape they need.
  const activeTagFilter = ref<Set<string>>(new Set())

  const activeTagList = computed(() => [...activeTagFilter.value])

  function toggleTag(tag: string) {
    const next = new Set(activeTagFilter.value)
    if (next.has(tag)) {
      next.delete(tag)
    } else {
      next.add(tag)
      // Ensure the user can see the filtered tree the moment they pick
      // a tag. Without this they'd have to manually switch to the
      // Files panel — which defeats the point of filtering.
      opts.activePanel.value = 'files'
    }
    activeTagFilter.value = next
  }

  function clear() {
    if (activeTagFilter.value.size === 0) return
    activeTagFilter.value = new Set()
  }

  function removeTag(tag: string) {
    if (!activeTagFilter.value.has(tag)) return
    const next = new Set(activeTagFilter.value)
    next.delete(tag)
    activeTagFilter.value = next
  }

  return {
    activeTagFilter,
    activeTagList,
    toggleTag,
    clear,
    removeTag,
  }
}
