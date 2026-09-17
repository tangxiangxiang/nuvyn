# 3-State Theme Toggle (Auto / Light / Dark) — Design

> **For agentic workers:** This is a design spec. Next step is the implementation plan under `docs/superpowers/plans/`.

**Goal:** Replace the placeholder theme button with a working 3-state cycle (auto → light → dark → auto), with the user's choice persisted in localStorage and a no-flash inline boot script that applies the theme before Vue mounts.

**Architecture:** Single source of truth (a module-level `ref<Theme>` in a `useTheme` composable) shared across components; CSS switching via a `data-theme` attribute on `<html>`; baseline `prefers-color-scheme` media query remains in place for `auto` mode and as a fallback.

**Tech Stack:** Vue 3 `<script setup>`, `@vueuse/core` is already in the dependency tree (used for `useStorage`/`useDebounceFn`), but we will NOT use `useStorage` here — `localStorage` is touched by both the inline boot script and the composable, and a single tiny `try/catch` + `getItem` is simpler than wiring the `useStorage` serializer. CSS custom properties + `data-theme` attribute selectors.

---

## State model

```ts
type Theme = 'auto' | 'light' | 'dark'
```

| State    | What the page renders                        | When picked                                                                |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| `auto`   | Whatever the OS reports (light or dark)      | Default. No `data-theme` attribute on `<html>` — media query applies.      |
| `light`  | Light values forced                          | User picked light. `data-theme="light"` on `<html>`.                       |
| `dark`   | Dark values forced                           | User picked dark. `data-theme="dark"` on `<html>`.                         |

Stored in `localStorage` under key `nuvyn.theme`. Values outside `{auto, light, dark}` are treated as `auto`.

## CSS switching strategy

`data-theme` is set on `<html>` (not `<body>`) so the inline boot script can target it before `<div id="app">` mounts.

```css
/* baseline (unchanged) */
:root { /* light defaults */ }
@media (prefers-color-scheme: dark) {
  :root { /* dark defaults */ }
}

/* NEW: user-forced overrides */
:root[data-theme='light'] {
  /* all nuvyn tokens (--text, --bg, --border, ...) re-pinned to LIGHT values */
  /* vault VSCode tokens re-pinned via nested :root[data-theme='light'] .vault { ... } */
}
:root[data-theme='dark'] {
  /* all nuvyn tokens re-pinned to DARK values */
  /* vault tokens re-pinned to DARK values */
}
```

**Specificity:** `:root` is (0,0,1); `:root[data-theme='dark']` is (0,1,1) — strictly higher than the media-query `:root` (0,0,1), so the user-forced value always wins.

**Vault scope:** The vault's VSCode palette currently lives in `.vault` with its own `@media (prefers-color-scheme: light)` block. The override rules apply to `.vault` selectors nested under `:root[data-theme=...]` so the vault also respects the user choice. Concretely, we add:

```css
:root[data-theme='light'] .vault { /* light vault token values */ }
:root[data-theme='dark']  .vault { /* dark vault token values */ }
```

and we keep the existing `prefers-color-scheme: light` rule as a fallback for `auto` mode.

## Composable — `src/composables/useTheme.ts`

Mirrors the module-singleton pattern in [src/composables/useToast.ts](../../../src/composables/useToast.ts) (a module-level `ref` so all consumers share the same state).

```ts
// src/composables/useTheme.ts
import { ref, computed, readonly, onMounted, onBeforeUnmount } from 'vue'

export type Theme = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'nuvyn.theme'
const ATTR = 'data-theme'

const theme = ref<Theme>(readSaved())
const systemDark = ref<boolean>(getSystemDark())

const mq = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function readSaved(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
  } catch { /* private mode etc. */ }
  return 'auto'
}
function getSystemDark(): boolean {
  return mq ? mq.matches : false
}
function apply(t: Theme) {
  const el = document.documentElement
  if (t === 'auto') el.removeAttribute(ATTR)
  else el.setAttribute(ATTR, t)
}

apply(theme.value) // keep DOM in sync if the inline boot script didn't run

const isDark = computed(() =>
  theme.value === 'dark' || (theme.value === 'auto' && systemDark.value),
)

function set(t: Theme) {
  theme.value = t
  try { localStorage.setItem(STORAGE_KEY, t) } catch { /* ignore */ }
  apply(t)
}
function cycle() {
  set(theme.value === 'auto' ? 'light' : theme.value === 'light' ? 'dark' : 'auto')
}

function onSystemChange() {
  systemDark.value = mq?.matches ?? false
}

export function useTheme() {
  onMounted(() => {
    mq?.addEventListener('change', onSystemChange)
  })
  onBeforeUnmount(() => {
    mq?.removeEventListener('change', onSystemChange)
  })
  return {
    theme: readonly(theme),
    isDark,
    set,
    cycle,
  }
}
```

**Notes:**
- The module-level `theme` ref is initialized from `readSaved()` (which reads `localStorage`), so the composable is in sync with whatever the inline boot script wrote, without re-reading.
- The `apply(theme.value)` call at module init is a safety net for the case where the inline boot script didn't run (e.g. SSR, or someone loading the page in a way that doesn't execute head scripts).
- `onMounted` / `onBeforeUnmount` are only used to register the `matchMedia` listener — call site must be inside a component `setup()` (it is — `NavBar.vue`).

## Inline boot script — `index.html`

Runs before the Vue bundle loads, so the theme is on `<html>` before first paint.

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem('nuvyn.theme');
      if (t === 'light' || t === 'dark') {
        document.documentElement.setAttribute('data-theme', t);
      }
    } catch (e) { /* private mode / storage blocked — fall through to system */ }
  })();
</script>
```

Inserted inside `<head>`, before the module script. Kept tiny: no Vue, no `matchMedia`, just read + set attribute.

## Button UX

The placeholder at [src/components/NavBar.vue:31-36](../../../src/components/NavBar.vue#L31-L36) becomes state-aware. Cycle order: `auto → light → dark → auto`.

| Current state | Icon (lucide-style 18×18 SVG) | Title / aria-label                                                          |
| ------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `auto`        | half sun + half moon          | `Theme: System (auto) — click for Light`                                    |
| `light`       | moon                          | `Theme: Light — click for Dark`                                             |
| `dark`        | sun                           | `Theme: Dark — click to follow System`                                      |

Icons match the line-weight and `stroke-linecap` of the existing SVGs in NavBar / ActivityBar (`stroke-width="2"` for navbar sizing, `viewBox="0 0 24 24"`). Each icon is a single inline `<svg>` swapped via `v-if` on the `theme` ref.

## Files to change

- **Create** [src/composables/useTheme.ts](../../../src/composables/useTheme.ts) — composable, types, module-level state
- **Modify** [index.html](../../../index.html) — inline boot script in `<head>`
- **Modify** [src/style.css](../../../src/style.css) — add `:root[data-theme=...]` override blocks (light + dark), including `.vault` scope
- **Modify** [src/components/NavBar.vue](../../../src/components/NavBar.vue) — wire up the toggle, switch icon, call `cycle()`

## Out of scope (YAGNI)

- No keyboard shortcut (⌘⇧T etc.) for the toggle.
- No transition animation on theme change beyond the existing `transition: color 0.15s` etc. that already cascade.
- No "Reset to system" menu — the cycle button already returns to `auto`.
- No per-component theme overrides.
- No SSR story — this is a client-only Vite app.

## Error handling

- `localStorage` access is wrapped in `try/catch` (private mode, storage disabled). The composable falls back to in-memory `auto` and lets the media query decide.
- `matchMedia` listener is only registered when `mq` exists (browser) and the function is called inside a component `setup()`.
- Invalid stored values (e.g. `nuvyn.theme = "purple"`) are treated as `auto`.

## Testing / verification

The project has no test framework. Verification:

1. `npm run build` passes (vue-tsc + vite).
2. Manual checks:
   - First load with no `nuvyn.theme` in localStorage → page follows OS theme.
   - Click toggle → page flips light/dark, button icon updates, `localStorage.nuvyn.theme` updates.
   - Reload → chosen theme persists (no flash).
   - In `auto` mode, change OS theme → page follows.
   - In `light`/`dark` mode, change OS theme → page does NOT follow (forced).
   - Vault: open a post in light and dark, verify all panes (file tree, editor, preview, status bar, command palette) use the chosen palette.

## Implementation order (for the plan)

1. Composable first (smallest, easiest to verify in isolation by logging from a temp component).
2. Inline boot script in `index.html` (one tiny script, no Vue dependency).
3. CSS overrides in `style.css` — light + dark, with vault scope. Without this step, clicking the button would not change colors.
4. NavBar button wiring + icon swap.
5. Full-app manual verification per the checklist above.
