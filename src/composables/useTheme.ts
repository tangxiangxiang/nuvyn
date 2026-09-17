import { ref, readonly } from 'vue'
import { NUVYN_BROWSER_STORAGE_KEYS, readStorageKey, writeStorageKey } from '../technicalNamespace'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.theme
const ATTR = 'data-theme'

/** Default when nothing is persisted: follow the OS preference.
 *  Inline boot script in index.html does the same read on first paint. */
function readSaved(): Theme {
  try {
    const raw = readStorageKey(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark') return raw
  } catch {
    /* private mode / storage blocked — fall through */
  }
  /* No persisted choice — defer to prefers-color-scheme via the media
     query in style.css, which paints the right palette immediately.
     matchMedia isn't available in every test environment (jsdom
     doesn't ship it) so we feature-detect rather than assume. */
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const theme = ref<Theme>(readSaved())

/** Keep DOM in sync at module load — covers the case where the inline
 *  boot script in index.html didn't run (e.g. private mode). */
function applyToDom(t: Theme) {
  const el = document.documentElement
  if (t === 'light' || t === 'dark') el.setAttribute(ATTR, t)
}
applyToDom(theme.value)

function set(t: Theme) {
  theme.value = t
  writeStorageKey(STORAGE_KEY, t)
  applyToDom(t)
}

function toggle() {
  set(theme.value === 'light' ? 'dark' : 'light')
}

export function useTheme() {
  return {
    theme: readonly(theme),
    set,
    toggle,
  }
}
