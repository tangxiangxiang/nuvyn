// Platform-aware keyboard shortcut display.
//
// `isMac` is computed once at module load (same pattern as useTheme's
// module-level `theme` ref): `navigator.platform` is static per
// browser, so there's no reason to re-detect. Feature-detects
// `navigator` so the module loads under SSR / Vitest without throwing.
//
// `format(combo)` translates a chord expressed with abstract keys
// (`mod+P`, `shift+mod+Z`) into the user's local convention:
//   - Mac: `⌘P`, `⇧⌘Z`
//   - other: `Ctrl+P`, `Shift+Ctrl+Z`
//
// `mod` and `cmd` both alias to the primary modifier (`⌘` on Mac,
// `Ctrl` elsewhere). Lower-case + upper-case segment spellings both
// work. Unknown segments pass through unchanged so the caller can
// mix abstract keys with literal labels (e.g. `format('mod+Tab')`).

import { ref, readonly, type Ref } from 'vue'

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || ''
  return /Mac|iPhone|iPad/.test(platform) || /Mac|iPhone|iPad/.test(ua)
}

const isMac: Ref<boolean> = ref(detectMac())

/* Per-key glyph table. Looked up via `KEY_MAP[seg.toLowerCase()]` —
   we lowercase so callers can write either `mod+P` or `Mod+P`.
   On non-Mac we spell out the names so the chip reads as
   `Ctrl+P` / `Shift+Tab` rather than a foreign glyph. */
const KEY_MAP: Record<string, string> = {
  mod: isMac.value ? '⌘' : 'Ctrl',
  cmd: isMac.value ? '⌘' : 'Ctrl',
  ctrl: isMac.value ? '⌃' : 'Ctrl',
  alt: isMac.value ? '⌥' : 'Alt',
  opt: isMac.value ? '⌥' : 'Alt',
  shift: isMac.value ? '⇧' : 'Shift',
  enter: isMac.value ? '↵' : 'Enter',
  return: isMac.value ? '↵' : 'Enter',
  esc: isMac.value ? '⎋' : 'Esc',
  escape: isMac.value ? '⎋' : 'Esc',
  tab: isMac.value ? '⇥' : 'Tab',
  space: isMac.value ? '␣' : 'Space',
  up: isMac.value ? '↑' : '↑',
  down: isMac.value ? '↓' : '↓',
  left: isMac.value ? '←' : '←',
  right: isMac.value ? '→' : '→',
}

function translateSegment(seg: string): string {
  const trimmed = seg.trim()
  if (trimmed.length === 0) return ''
  const lower = trimmed.toLowerCase()
  const mapped = KEY_MAP[lower]
  if (mapped !== undefined) return mapped
  /* Plain key letters / names pass through as-is so `P` stays `P`,
     `F5` stays `F5`. Mac convention capitalizes chord letters on
     non-Mac — a small nicety that keeps `⌘P` and `Ctrl+P` visually
     parallel. */
  return isMac.value ? trimmed : trimmed.length === 1 ? trimmed.toUpperCase() : trimmed
}

function format(combo: string): string {
  if (!combo) return ''
  return combo
    .split('+')
    .map(translateSegment)
    .filter((s) => s.length > 0)
    .join(isMac.value ? '' : '+')
}

export function useShortcutDisplay() {
  return {
    isMac: readonly(isMac),
    format,
  }
}