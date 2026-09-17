// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { useEditorPreferences } from '../useEditorPreferences'

describe('useEditorPreferences', () => {
  it('clamps numeric settings and restores defaults', async () => {
    const preferences = useEditorPreferences()
    preferences.fontSize.value = 99
    preferences.lineHeight.value = 1
    preferences.wrapColumn.value = 999
    preferences.tabSize.value = 3 as any
    await nextTick()
    expect(preferences.fontSize.value).toBe(24)
    expect(preferences.lineHeight.value).toBe(16)
    expect(preferences.wrapColumn.value).toBe(160)
    expect(preferences.tabSize.value).toBe(2)

    preferences.fontFamily.value = 'JetBrains Mono'
    preferences.typography.value = false
    preferences.reset()
    expect(preferences.fontSize.value).toBe(14)
    expect(preferences.lineHeight.value).toBe(22)
    expect(preferences.tabSize.value).toBe(2)
    expect(preferences.wrapColumn.value).toBe(100)
    expect(preferences.fontFamily.value).toBe('')
    expect(preferences.typography.value).toBe(true)
  })
})
