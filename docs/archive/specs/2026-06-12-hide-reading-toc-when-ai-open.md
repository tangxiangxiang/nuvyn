# Hide Reading TOC when AI Panel is Open

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the AI panel is open in the vault's read mode, the right-side "页面导航" (page navigation / TOC) disappears and the article expands rightward to fill the space the TOC used to occupy.

**Architecture:** Add an `ai-open` class to the `.vault` root element in `VaultView.vue` (sibling of the existing `is-read` class), and use two CSS rules to hide the TOC and let the article flex-grow into the freed space. No new components, no new props, no new state — `aiOpen` is already a reactive ref in `useVaultLayout`.

**Tech Stack:** Vue 3 (template `:class` binding), CSS (scoped rules in `style.css`).

---

## Problem

In read mode the vault shows a sticky right-side TOC (the `<aside class="reading-toc">` in `ReadingPane.vue`) with the heading "页面导航". The TOC sits in the right 220px of the reading pane, and the article is centered at 720px with a 32px gap between them.

When the user opens the AI panel, the right rail is occupied by the AI chat. The reading pane shrinks (the 1fr track in the vault grid narrows), but the TOC is still rendered and is still wasting 220px of horizontal space on top of the AI panel's footprint. The article does not adapt — it stays at 720px (or `75ch`, whichever is smaller) and there is a large empty band on the right where the TOC would be.

The user wants: AI open → TOC hidden, article expands right to use that space.

## Solution

### Component 1: `VaultView.vue` — add `ai-open` class

`useVaultLayout` already exposes `aiOpen` as a reactive ref ([src/composables/vault/useVaultLayout.ts:90](../../../src/composables/vault/useVaultLayout.ts#L90)). `VaultView.vue` already destructures `aiOpen` at [src/views/VaultView.vue:40](../../../src/views/VaultView.vue#L40). The only change is the root element's `:class` binding:

```vue
<div
  ref="vaultRef"
  class="vault"
  :class="{ 'is-read': isReadMode, 'ai-open': aiOpen }"
  ...
>
```

This mirrors the existing `is-read` pattern (one boolean in, one class out) and gives us a single class to anchor CSS rules on. The `vaultRef` template ref, drag handlers, and tab/side-panel logic are all unchanged.

### Component 2: `style.css` — two new rules

Append to `style.css` next to the existing `.vault .reading-toc` and `.vault .reading-layout` rules:

```css
/* AI panel open: hide the right-side TOC, let the article expand
   into the freed space. The original reading-layout max-width
   (720 article + 32 gap + 220 TOC = 972px) is unchanged — with
   the TOC removed, the article flex-grows to fill the same total
   width its row was already sized for. */
.vault.ai-open .reading-toc {
  display: none;
}
.vault.ai-open .reading-layout .article.reading {
  /* flex: 0 1 720px → flex: 1 1 720px: allow growth into the
     freed 220 + 32 = 252px of horizontal space. */
  flex: 1 1 720px;
  /* max-width: 75ch (~612px English, ~1224px CJK) is the readability
     cap that the original design added. With the AI panel eating
     the right rail, the user has actively chosen to give up that
     rail — so we lift the cap and let the article use the space. */
  max-width: none;
}
```

The two rules are intentionally separate from the existing ones so a future reader can see at a glance "this is the AI-open variant" without diff noise inside the base block.

### Why CSS class instead of a prop on `ReadingPane`

Two reasons the class-on-`.vault` approach is preferred to a `hideToc` prop on `ReadingPane`:

1. **Encapsulation.** "AI is open" is a layout concern, not a reading-pane concern. A prop would force `ReadingPane` to know about the AI panel — a coupling that doesn't exist today and isn't justified by the current use case.
2. **The article expansion is also a layout concern.** Even with a `hideToc` prop, we'd still need a CSS rule on the layout / article to do the flex-grow work. A prop would just add an extra hop for the same final result.

## Edge cases

| Case | Behavior |
|---|---|
| Edit mode (no `ReadingPane`) | `ReadingPane` is not mounted; CSS selectors don't match; zero effect. |
| Read mode with no headings (`headings.length === 0`) | The `<aside>` is already `v-if`'d out at [ReadingPane.vue:204](../../../src/components/vault/ReadingPane.vue#L204). The `display: none` rule is a harmless no-op. The article still `flex-grow: 1`s, but with only one flex child the layout's `max-width: 972px` still bounds the article, and `flex: 1 1 720px` with one child fills the row up to the cap. Visually identical to "AI closed, no headings". |
| AI open then closed (toggle) | The class flip is instant, the `display: none` flip is instant. No transition (none was requested; adding one would muddy the sticky scroll-spy timing). |
| AI panel dragged to its 600px max | The reading pane's `1fr` track narrows; the layout's `max-width: 972px` clamps first, so the article tops out at ~940px and the right whitespace is at most the AI panel's footprint. The article never overflows. |
| Very wide viewport (reading pane > 972px) | The `max-width: 972px` on the layout still caps the row. Article tops out at ~940px, layout is centered with `margin: 0 auto`, whitespace on both sides. Same as today. |
| Narrow viewport (reading pane < 972px) | The `max-width: 972px` doesn't bind; the layout shrinks to the reading pane's available width. The article fills the row (with `max-width: none` overriding the 75ch cap so it actually can fill the row). Visually: the article takes the full reading-pane width. Acceptable — the user opened the AI panel, they're choosing to use the space. |

## What we are NOT doing (YAGNI)

- ❌ No transition / animation on the TOC hide or article resize. Not requested; would interact badly with the sticky scroll-spy observer timing.
- ❌ No new persisted preference. "AI open → TOC hidden" is a pure function of `aiOpen`, which is already persisted.
- ❌ No changes to `ReadingPane.vue`. The component doesn't need to know the AI panel exists.
- ❌ No narrow-viewport special case. The existing rules (`.reading-toc { flex: 0 0 220px }`) already collapse the TOC at small widths; `display: none` and `flex-grow: 1` are still correct (or harmless no-ops) at those widths.
- ❌ No new tests for the layout composition. `useVaultLayout.test.ts` already covers `aiOpen` toggling; the `:class` binding is a one-liner that vue-tsc verifies. The behavior is purely visual and is best verified by screenshot.

## Testing

1. **Visual smoke test** with `/tmp/cdp-drive.mjs`:
   - Navigate to a long vault post in read mode (e.g. `/vault/notes/some-long-post` then click the read-mode toggle)
   - Screenshot 1: AI closed → TOC visible on the right at 220px, article centered at ~720px
   - Click the AI toggle in the activity bar
   - Screenshot 2: AI open → TOC gone, article visibly wider, AI panel docked on the right
   - Click the AI toggle again
   - Screenshot 3: matches screenshot 1
2. **Existing test suite:** `pnpm test` and `pnpm typecheck` must stay green. No new tests required.
3. **Manual check the read mode → edit mode transition:** the `ai-open` class persists across the mode swap (it's on the `.vault` root, not on `ReadingPane`). When the user closes the AI panel while in edit mode, the class flips off and the edit-mode preview is unaffected. Confirm in the screenshot run above by toggling the view mode while AI is open.

## Files changed

| File | Lines | Change |
|---|---|---|
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | +1 | Add `'ai-open': aiOpen` to the `.vault` `:class` binding |
| [src/style.css](../../../src/style.css) | +~15 | Two new CSS rules under a single comment block |

Total: ~16 lines added, 0 lines removed, 0 files restructured.
