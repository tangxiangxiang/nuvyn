// Tests for the multi-select tag filter composable. The old design was a
// single string ref that toggled on/off; the new one is a Set<string> with
// OR semantics across the active set, plus explicit clear() and removeTag()
// helpers so the UI can drop a single chip without nuking the rest.

import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useTagFilter } from '../useTagFilter'

function make() {
  const activePanel = ref<'files' | 'tags' | null>(null)
  const f = useTagFilter({ activePanel })
  return { f, activePanel }
}

describe('useTagFilter', () => {
  it('starts with an empty set and no panel switch', () => {
    const { f, activePanel } = make()
    expect([...f.activeTagFilter.value]).toEqual([])
    expect(f.activeTagList.value).toEqual([])
    expect(activePanel.value).toBeNull()
  })

  it('toggles a tag on and off', () => {
    const { f } = make()
    f.toggleTag('reference')
    expect(f.activeTagList.value).toEqual(['reference'])
    f.toggleTag('reference')
    expect(f.activeTagList.value).toEqual([])
  })

  it('accumulates multiple tags (OR set, not replace)', () => {
    const { f } = make()
    f.toggleTag('reference')
    f.toggleTag('markdown')
    expect(new Set(f.activeTagList.value)).toEqual(new Set(['reference', 'markdown']))
  })

  it('removing one tag preserves the others', () => {
    const { f } = make()
    f.toggleTag('reference')
    f.toggleTag('markdown')
    f.removeTag('reference')
    expect(f.activeTagList.value).toEqual(['markdown'])
  })

  it('removeTag is a no-op when the tag is not active', () => {
    const { f } = make()
    f.toggleTag('reference')
    f.removeTag('markdown')              // never added
    expect(f.activeTagList.value).toEqual(['reference'])
  })

  it('clear() empties the set in one call', () => {
    const { f } = make()
    f.toggleTag('a')
    f.toggleTag('b')
    f.toggleTag('c')
    f.clear()
    expect(f.activeTagList.value).toEqual([])
  })

  it('clear() is a no-op when already empty', () => {
    const { f } = make()
    // No throw, no side effect.
    f.clear()
    expect(f.activeTagList.value).toEqual([])
  })

  it('flips the activePanel to "files" when a tag is added, so the filtered tree becomes visible', () => {
    const { f, activePanel } = make()
    activePanel.value = 'tags'
    f.toggleTag('reference')
    expect(activePanel.value).toBe('files')
  })

  it('does not flip the panel when removing a tag (we are already on the files view)', () => {
    const { f, activePanel } = make()
    f.toggleTag('reference')              // flips to 'files'
    activePanel.value = 'tags'            // user moved away
    f.removeTag('reference')              // removing should not push us back
    expect(activePanel.value).toBe('tags')
    expect(f.activeTagList.value).toEqual([])
  })

  it('returns a new Set on every change so dependents re-render', () => {
    const { f } = make()
    const a = f.activeTagFilter.value
    f.toggleTag('reference')
    const b = f.activeTagFilter.value
    expect(a).not.toBe(b)
  })
})
