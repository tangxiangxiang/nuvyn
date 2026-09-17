import { useStorage } from '@vueuse/core'
import { watch } from 'vue'
import { NUVYN_BROWSER_STORAGE_KEYS } from '../../technicalNamespace'

const fontSize = useStorage(NUVYN_BROWSER_STORAGE_KEYS.editorFontSize, 14)
const lineHeight = useStorage(NUVYN_BROWSER_STORAGE_KEYS.editorLineHeight, 22)
const tabSize = useStorage<2 | 4>(NUVYN_BROWSER_STORAGE_KEYS.editorTabSize, 2)
const wrapColumn = useStorage(NUVYN_BROWSER_STORAGE_KEYS.editorWrapColumn, 100)
const fontFamily = useStorage(NUVYN_BROWSER_STORAGE_KEYS.editorFontFamily, '')
const typography = useStorage(NUVYN_BROWSER_STORAGE_KEYS.editorTypography, true)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)))
watch(fontSize, (value) => { fontSize.value = clamp(Number(value) || 14, 11, 24) })
watch(lineHeight, (value) => { lineHeight.value = clamp(Number(value) || 22, 16, 40) })
watch(wrapColumn, (value) => { wrapColumn.value = clamp(Number(value) || 100, 60, 160) })
watch(tabSize, (value) => { tabSize.value = Number(value) === 4 ? 4 : 2 })

function reset() {
  fontSize.value = 14
  lineHeight.value = 22
  tabSize.value = 2
  wrapColumn.value = 100
  fontFamily.value = ''
  typography.value = true
}

export function useEditorPreferences() {
  return {
    fontSize, lineHeight, tabSize, wrapColumn, fontFamily, typography, reset,
  }
}
