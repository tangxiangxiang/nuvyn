import { useStorage } from '@vueuse/core'
import { NUVYN_BROWSER_STORAGE_KEYS } from '../../technicalNamespace'

// Device-local presentation preference. New users default to the denser,
// single-line tree; turning it off lets the selected row reveal its path.
const STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.fileTreeCompact
const compactFileTree = useStorage(STORAGE_KEY, true)

export function useFileTreePreferences() {
  return { compactFileTree }
}
