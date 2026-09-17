# 3-State Theme Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder theme button in [src/components/NavBar.vue](../../../src/components/NavBar.vue) with a working 3-state cycle (auto → light → dark → auto), persisted in `localStorage`, with no flash on reload.

**Architecture:** Module-level `ref<Theme>` in a `useTheme` composable (singleton, mirrors the `useToast` pattern). CSS switching via a `data-theme` attribute on `<html>`, set both by an inline boot script in `index.html` (pre-mount, no flash) and by the composable. Higher-specificity `:root[data-theme=...]` selectors override the existing `prefers-color-scheme` media query.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, vanilla CSS custom properties. No test framework — verification is `npm run build` (runs `vue-tsc -b && vite build`) plus manual UI checks.

**Spec:** [docs/superpowers/specs/2026-06-02-theme-toggle-design.md](../specs/2026-06-02-theme-toggle-design.md)

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| [src/composables/useTheme.ts](../../../src/composables/useTheme.ts) | create | Module-singleton state, `cycle()` / `set()` / `isDark`, `matchMedia` listener |
| [index.html](../../../index.html) | modify | Inline boot script that sets `data-theme` before Vue mounts |
| [src/style.css](../../../src/style.css) | modify | Add `:root[data-theme='light'\|'dark']` override blocks (nuvyn tokens + vault scope) |
| [src/components/NavBar.vue](../../../src/components/NavBar.vue) | modify | Wire up the existing placeholder button: call `cycle()`, swap icon, update title/aria-label |

Each task produces a self-contained, buildable, committable change. Tasks are ordered to keep the codebase in a working state at every commit boundary.

---

## Task 1: Create the `useTheme` composable

**Files:**
- Create: `src/composables/useTheme.ts`

- [ ] **Step 1: Write the composable**

Create `src/composables/useTheme.ts` with this exact content:

```ts
import { ref, computed, readonly, onMounted, onBeforeUnmount } from 'vue'

export type Theme = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'nuvyn.theme'
const ATTR = 'data-theme'

/** Module-level singleton state. Initialized once at module load. */
const theme = ref<Theme>(readSaved())
const systemDark = ref<boolean>(getSystemDark())

/** Single matchMedia instance, lazy (null on SSR / non-browser). */
const mq = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function readSaved(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
  } catch {
    /* private mode / storage blocked — fall through */
  }
  return 'auto'
}

function getSystemDark(): boolean {
  return mq ? mq.matches : false
}

function applyToDom(t: Theme) {
  const el = document.documentElement
  if (t === 'auto') el.removeAttribute(ATTR)
  else el.setAttribute(ATTR, t)
}

// Keep DOM in sync at module load — covers the case where the inline
// boot script in index.html didn't run (e.g. private mode).
applyToDom(theme.value)

const isDark = computed(() =>
  theme.value === 'dark' || (theme.value === 'auto' && systemDark.value),
)

function set(t: Theme) {
  theme.value = t
  try { localStorage.setItem(STORAGE_KEY, t) } catch { /* ignore */ }
  applyToDom(t)
}

function cycle() {
  set(theme.value === 'auto' ? 'light' : theme.value === 'light' ? 'dark' : 'auto')
}

function onSystemChange() {
  systemDark.value = mq?.matches ?? false
}

export function useTheme() {
  // Lifecycle hooks are valid here only when called from a component
  // setup(). The only caller in this app is NavBar.vue, so this is safe.
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

- [ ] **Step 2: Verify the build**

Run from the repo root:

```bash
npm run build
```

Expected: build succeeds. The composable isn't imported anywhere yet, so vue-tsc still type-checks it (it's a top-level export). If `npm run build` fails on the composable, fix the type errors and re-run.

- [ ] **Step 3: Commit**

```bash
git add src/composables/useTheme.ts
git commit -m "feat(theme): add useTheme composable with 3-state cycle"
```

---

## Task 2: Add the inline boot script to `index.html`

**Files:**
- Modify: `index.html` (insert one `<script>` block inside `<head>`, before the existing `<link rel="icon">`)

- [ ] **Step 1: Insert the boot script**

In [index.html](../../../index.html), change the `<head>` block from:

```html
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>nuvyn</title>
  </head>
```

to:

```html
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>nuvyn</title>
    <script>
      // Apply persisted theme before Vue mounts to avoid a flash of
      // the wrong palette. Mirrors the storage key in useTheme.ts.
      (function () {
        try {
          var t = localStorage.getItem('nuvyn.theme');
          if (t === 'light' || t === 'dark') {
            document.documentElement.setAttribute('data-theme', t);
          }
        } catch (e) { /* private mode / storage blocked — let CSS media query decide */ }
      })();
    </script>
  </head>
```

Note: the script is intentionally inside `<head>` (not at the end of `<body>`). Browsers parse and execute head scripts before the body is rendered, so the attribute is on `<html>` before the first paint of `<div id="app">`.

- [ ] **Step 2: Verify the build**

```bash
npm run build
```

Expected: build succeeds. The script is plain JS, no type errors.

- [ ] **Step 3: Manual sanity check**

Run `npm run dev` in a terminal, then in the browser:
1. Open DevTools → Application → Local Storage. Confirm there is no `nuvyn.theme` key yet.
2. In the browser console, run: `localStorage.setItem('nuvyn.theme', 'dark'); location.reload();`
3. The page should reload already in dark mode (with the existing `prefers-color-scheme: dark` baseline, this looks identical to system-dark, but the *attribute* is now set).
4. DevTools → Elements → inspect `<html>`: it should have `data-theme="dark"`.
5. Then `localStorage.removeItem('nuvyn.theme'); location.reload();` — the `data-theme` attribute should be gone after reload.

If any step shows a wrong attribute, fix the boot script and re-test.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "fix(theme): pre-mount boot script to avoid flash of wrong palette"
```

---

## Task 3: Add CSS overrides for `:root[data-theme=...]`

**Files:**
- Modify: [src/style.css](../../../src/style.css) — append a new section at the END of the file (cascade order matters: overrides must come after the existing media query)

- [ ] **Step 1: Append the override blocks**

At the very end of `src/style.css`, after line 1122 (`.article ul.contains-task-list { padding-left: 1.2em; }`), add this block. Do not modify any existing rules.

```css
/* ---------- User-forced theme (data-theme on <html>) ----------
   Higher specificity than the prefers-color-scheme media query
   (`:root[data-theme=X]` beats `:root` inside `@media`), so when the
   user has picked light or dark explicitly it wins over the OS. In
   `auto` mode no attribute is set and the media query applies.

   Token values mirror the baseline :root and the
   prefers-color-scheme: dark / light :root blocks above. */

:root[data-theme='light'] {
  --text: #4b5563;
  --text-h: #111827;
  --text-muted: #6b7280;
  --bg: #ffffff;
  --bg-soft: #f9fafb;
  --border: #e5e7eb;
  --code-bg: #f3f4f6;
  --accent: #6366f1;
  --accent-hover: #4f46e5;
}

:root[data-theme='dark'] {
  --text: #d1d5db;
  --text-h: #f9fafb;
  --text-muted: #9ca3af;
  --bg: #111827;
  --bg-soft: #1f2937;
  --border: #374151;
  --code-bg: #1f2937;
  --accent: #818cf8;
  --accent-hover: #a5b4fc;
}

/* Vault: same idea, but the vault overrides live on .vault with its
   own VSCode palette. We re-pin them under :root[data-theme=...] so
   the vault respects the user's choice (not just the OS). */

:root[data-theme='light'] .vault {
  --vs-bg-1: #ffffff;
  --vs-bg-2: #f3f3f3;
  --vs-bg-3: #dddddd;
  --vs-bg-4: #ececec;
  --vs-border: #e0e0e0;
  --vs-text-1: #1f1f1f;
  --vs-text-2: #6f6f6f;
  --vs-text-3: #999999;
  --vs-accent: #005fb8;
  --vs-accent-hover: #0258a8;
  --vs-accent-bg: rgba(0, 95, 184, 0.1);
  --vs-active-bg: #e8e8e8;
  --vs-tab-active-bg: #ffffff;
  --vs-tab-inactive-bg: #ececec;
  --vs-hover-bg: #ececec;
  --vs-status-bg: #005fb8;
  --vs-status-fg: #ffffff;
  --code-bg: #f3f4f6;
  --text: var(--vs-text-1);
  --text-h: var(--vs-text-1);
  --text-muted: var(--vs-text-2);
  --bg: var(--vs-bg-1);
  --bg-soft: var(--vs-bg-2);
  --border: var(--vs-border);
  --accent: var(--vs-accent);
  --accent-hover: var(--vs-accent-hover);
  --accent-bg: var(--vs-accent-bg);
}

:root[data-theme='dark'] .vault {
  --vs-bg-1: #1e1e1e;
  --vs-bg-2: #252526;
  --vs-bg-3: #333333;
  --vs-bg-4: #2d2d2d;
  --vs-border: #3c3c3c;
  --vs-text-1: #d4d4d4;
  --vs-text-2: #858585;
  --vs-text-3: #6a6a6a;
  --vs-accent: #007acc;
  --vs-accent-hover: #1f8ad2;
  --vs-accent-bg: rgba(0, 122, 204, 0.2);
  --vs-active-bg: #37373d;
  --vs-tab-active-bg: #1e1e1e;
  --vs-tab-inactive-bg: #2d2d2d;
  --vs-hover-bg: #2a2d2e;
  --vs-status-bg: #007acc;
  --vs-status-fg: #ffffff;
  --code-bg: #2a2a2a;
  --text: var(--vs-text-1);
  --text-h: var(--vs-text-1);
  --text-muted: var(--vs-text-2);
  --bg: var(--vs-bg-1);
  --bg-soft: var(--vs-bg-2);
  --border: var(--vs-border);
  --accent: var(--vs-accent);
  --accent-hover: var(--vs-accent-hover);
  --accent-bg: var(--vs-accent-bg);
}
```

**Why duplicate the nuvyn-token re-binding in the vault blocks:** the existing `.vault { --text: var(--vs-text-1); ... }` block (around line 401-414) re-binds nuvyn tokens to the VSCode palette. When `:root[data-theme='dark']` sets the *outer* nuvyn tokens (line 3 of the dark block above), it would override the vault's re-binding because both rules target `--text` on elements that match both selectors. Re-binding inside the vault scope preserves the intended "nuvyn tokens reflect the VSCode palette inside the vault" property under forced themes too.

- [ ] **Step 2: Verify the build**

```bash
npm run build
```

Expected: build succeeds (CSS changes don't go through vue-tsc).

- [ ] **Step 3: Manual sanity check (forced theme)**

Run `npm run dev`, then in the browser:

1. **Light forced**: in DevTools console, run `document.documentElement.setAttribute('data-theme', 'light')`. The page should immediately render in the light palette. Toggle your OS to dark mode — the page should STAY light (forced overrides OS).
2. **Dark forced**: `document.documentElement.setAttribute('data-theme', 'dark')`. Page should render dark. OS toggle to light — page should STAY dark.
3. **Auto (no attribute)**: `document.documentElement.removeAttribute('data-theme')`. Page should follow the OS theme again.
4. **Vault scope check**: navigate to `/vault/<any-slug>` and repeat steps 1-3. The vault's file tree, editor, preview, status bar, breadcrumb, and command palette should all switch correctly with the forced theme.

If any of the above doesn't behave as described, double-check the selector specificity and the cascade order (the new rules must come AFTER the existing media-query rules in the file).

- [ ] **Step 4: Clean up and commit**

The dev console mutations above are not persisted to localStorage. Clear them out before committing by reloading the page once.

```bash
git add src/style.css
git commit -m "feat(theme): data-theme overrides for light/dark (incl. vault scope)"
```

---

## Task 4: Wire up the NavBar button

**Files:**
- Modify: [src/components/NavBar.vue](../../../src/components/NavBar.vue) — script setup + template button block

- [ ] **Step 1: Update the `<script setup>` block**

Replace the existing top of the file (lines 1-7):

```ts
<script setup lang="ts">
import { RouterLink } from 'vue-router'

defineProps<{ isVault?: boolean }>()
const emit = defineEmits<{
  'open-search': []
}>()
</script>
```

with:

```ts
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useTheme, type Theme } from '../composables/useTheme'

defineProps<{ isVault?: boolean }>()
const emit = defineEmits<{
  'open-search': []
}>()

const { theme, cycle } = useTheme()

/* Per-state icon + tooltip. The icon reflects the CURRENT theme;
   the title hints at the next click action. */
const themeIcon = computed<'sun' | 'moon' | 'sun-moon'>(() => {
  if (theme.value === 'light') return 'moon'   // currently light → next click is dark
  if (theme.value === 'dark') return 'sun'    // currently dark  → next click is auto
  return 'sun-moon'                            // currently auto  → next click is light
})

const themeTitle = computed<string>(() => {
  const next = nextLabel(theme.value)
  return `Theme: ${label(theme.value)} (click for ${next})`
})

function label(t: Theme): string {
  return t === 'auto' ? 'System (auto)' : t === 'light' ? 'Light' : 'Dark'
}
function nextLabel(t: Theme): string {
  return t === 'auto' ? 'Light' : t === 'light' ? 'Dark' : 'System'
}
</script>
```

- [ ] **Step 2: Replace the placeholder button**

In the same file, replace the existing theme-toggle button block (lines 31-36, the one with the current single sun SVG):

```html
      <button class="theme-toggle" type="button" title="Theme (placeholder)" aria-label="Toggle theme">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      </button>
```

with:

```html
      <button
        class="theme-toggle"
        type="button"
        :title="themeTitle"
        :aria-label="themeTitle"
        @click="cycle"
      >
        <!-- auto: half-sun + half-moon (SunMoon) -->
        <svg v-if="themeIcon === 'sun-moon'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4" />
          <path d="M12 2v2" />
          <path d="m19 5 1.5 1.5" />
          <path d="M22 12h-2" />
          <path d="m19 19-1.5-1.5" />
          <path d="M22 14v-2" />
        </svg>
        <!-- light: moon (currently light, click → dark) -->
        <svg v-else-if="themeIcon === 'moon'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <!-- dark: sun (currently dark, click → auto) -->
        <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      </button>
```

- [ ] **Step 3: Verify the build**

```bash
npm run build
```

Expected: build succeeds. Watch for:
- "Cannot find module '../composables/useTheme'" — usually means the import path is wrong; it should be `../composables/useTheme` from `src/components/NavBar.vue`.
- Type errors on `theme.value` — the export is `readonly(theme)`, which is `DeepReadonly<Ref<Theme>>`, and `.value` is still `Theme`. Should be fine.
- vue-tsc complaining about `Theme` import — `Theme` is a type-only export, use `import type { Theme }` or just inline import (`import { useTheme, type Theme }`) as shown above. The `import { useTheme, type Theme }` form is supported in TypeScript 4.5+ and works with vue-tsc.

- [ ] **Step 4: Manual check**

Run `npm run dev`. In the browser:

1. The toggle button should show the "half-sun/half-moon" icon (auto is the default for a fresh visit).
2. Hover the button — tooltip should read `Theme: System (auto) (click for Light)`.
3. Click once. Page flips to light, icon becomes a moon, tooltip changes to `Theme: Light (click for Dark)`.
4. Click again. Page flips to dark, icon becomes a sun, tooltip changes to `Theme: Dark (click for System)`.
5. Click again. Page returns to system follow, icon becomes the half-sun/half-moon.
6. `localStorage.getItem('nuvyn.theme')` should be `'light'`, then `'dark'`, then `'auto'` (in that order, matching the clicks).
7. Reload the page after step 3 (light) — page should reload already in light, no flash of dark.
8. Reload after step 4 (dark) — page should reload in dark, no flash of light.
9. Reload after step 5 (auto) — page should reload following OS.

If any step is off, fix the component (most likely culprit: missing import or a v-if/v-else-if condition typo) and re-test.

- [ ] **Step 5: Commit**

```bash
git add src/components/NavBar.vue
git commit -m "feat(theme): wire 3-state cycle button with state-aware icon"
```

---

## Task 5: Final verification

**Files:** none modified — this task is a checklist only.

- [ ] **Step 1: Clean build**

```bash
npm run build
```

Expected: build succeeds with no warnings or errors.

- [ ] **Step 2: Run the full manual verification checklist from the spec**

Walk through the spec's "Testing / verification" section:

1. First load with no `nuvyn.theme` in localStorage → page follows OS theme. ✓
2. Click toggle → page flips light/dark, button icon updates, `localStorage.nuvyn.theme` updates. ✓
3. Reload → chosen theme persists (no flash). ✓
4. In `auto` mode, change OS theme → page follows. ✓
5. In `light`/`dark` mode, change OS theme → page does NOT follow (forced). ✓
6. Vault: open a post in light and dark, verify all panes (file tree, editor, preview, status bar, command palette) use the chosen palette. ✓

Each item is verifiable from a single dev server session. Note any that don't pass and address them before declaring done.

- [ ] **Step 3: Confirm working tree is clean**

```bash
git status
```

Expected: nothing to commit. All 4 implementation commits should be present:
- `feat(theme): add useTheme composable with 3-state cycle`
- `fix(theme): pre-mount boot script to avoid flash of wrong palette`
- `feat(theme): data-theme overrides for light/dark (incl. vault scope)`
- `feat(theme): wire 3-state cycle button with state-aware icon`

Run `git log --oneline -5` to confirm.

---

## Notes for implementers

- The composable is a module-singleton. If you ever call `useTheme()` from multiple components, the `matchMedia` listener is added/removed per call (NavBar is the only caller in this app, so the listener is added once on mount and removed once on unmount). Duplicate listeners would be harmless because the handler is idempotent.
- Don't refactor the existing `.vault` block at line 401-414. The plan re-creates its token re-binding inside the `:root[data-theme=...] .vault` blocks instead. If you want to factor this out into CSS variables-of-variables, that's a separate refactor.
- The `inline-block` boot script intentionally uses `var`+`function`+`try/catch` so it parses even in extremely old JS engines, and `try/catch` covers the `localStorage` throw in private mode.
- If you want to add a keyboard shortcut later (e.g. ⌘⇧T), wire it in NavBar's existing `onKeydown` handler — it's already a global key listener.
