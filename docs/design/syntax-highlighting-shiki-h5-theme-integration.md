# Nuvyn Shiki H5 — Theme Integration

本记录是 SHIKI-H5 的实现与验证证据。H5 只把 H4 的 dual-theme Shiki
variables 接入 Nuvyn reader 的 CSS theme precedence，不包含 PDF printable-light
integration、highlight.js cleanup 或主题产品模型重设计。

## 1. Phase metadata

| Item | Evidence |
| --- | --- |
| Phase | `SHIKI-H5 — Theme Integration` |
| H5 base / H4 completion | `e302c55791f779aead8bfa45ce9a9733245796d8` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| H4 completion commit | `e302c55791f779aead8bfa45ce9a9733245796d8` |
| H5 completion commit | `9d5d8a9ae0e19ee833f199784c9c5616cb02f237` |
| Runtime | Node `v24.15.0`, npm `11.12.1`; Docker baseline remains `node:22-bookworm-slim` |
| Status | H5 COMPLETE; H6/H7 NOT STARTED |

H5 does not change the historical implementation baseline. No changes were made
to `useTheme.ts`, `index.html`, the theme persistence contract, PDF code or the
highlight.js cleanup boundary.

## 2. Theme model baseline

Nuvyn remains a concrete two-state theme model:

```text
Theme = 'light' | 'dark'
localStorage key = nuvyn.theme
persisted system state = none
```

The existing boot/runtime behavior is preserved:

- `index.html` applies a persisted `light` or `dark` attribute before Vue mounts;
- without a saved choice, the initial CSS media query can paint from the OS;
- `useTheme.ts` reads the OS preference when no value is saved and then applies a
  concrete `data-theme="light"` or `data-theme="dark"` value;
- `useTheme().set()` still persists the concrete choice and updates the attribute.

H5 did not add a persistent `system` value, change the toggle API, or change the
boot script. The no-attribute cases below are CSS fallback evidence for the
initial/pre-Vue period, not a new product-level system state.

## 3. Static Shiki CSS architecture

H5 adds `src/shiki.css` and imports it from `src/main.ts` immediately after
`src/style.css`. The static file owns only:

- consumption of `--shiki-light` / `--shiki-dark` token variables;
- consumption of `--shiki-light-bg` / `--shiki-dark-bg` block variables;
- explicit light/dark and OS fallback selector precedence;
- readable colors for `nuvyn-shiki-plain` fallback blocks.

Generic `pre`/`code` layout remains in `src/style.css`. Because the existing
`.article pre` and `.vault .article pre` rules own code surfaces, the base Shiki
root selector includes the small specificity required for `.article pre.shiki`
to consume the Shiki background variable in the real reader. No padding, margin,
border, radius, font, line-height, overflow or pagination rule was copied.

The CSS does not hardcode generated token hashes or GitHub palette hex values.
It consumes the trusted variables emitted by H4's one shared transformer.

## 4. Generated variable contract

The actual Shiki 4.4.3 + `transformerStyleToClass` output has this shape:

```css
.nuvyn-shiki-token {
  --shiki-light: <github-light-token>;
  --shiki-dark: <github-dark-token>;
}

.nuvyn-shiki-root {
  --shiki-light: <github-light-foreground>;
  --shiki-dark: <github-dark-foreground>;
  --shiki-light-bg: <github-light-background>;
  --shiki-dark-bg: <github-dark-background>;
}
```

H5 applies `color` and `background-color` to both `.shiki` and descendant token
spans. A token span therefore resolves its own token variables; a span without
an override inherits the root Shiki variables. The generated stylesheet owner
remains the complete trusted snapshot:

```text
document.head
└── style#nuvyn-shiki-generated-styles
```

H5 does not mutate this owner when the reader theme changes.

## 5. Selector precedence

The static light default and dark media fallback are followed by explicit
`data-theme` selectors. This ordering preserves the existing Nuvyn precedence:

| `data-theme` | OS preference | Selected Shiki palette |
| --- | --- | --- |
| `light` | light | github-light |
| `light` | dark | github-light |
| `dark` | light | github-dark |
| `dark` | dark | github-dark |
| absent | light | github-light |
| absent | dark | github-dark |

The last two rows remove the attribute after rendering and emulate the OS media
query. They verify CSS fallback only and do not persist an additional theme
state.

The effective rules are:

```css
.shiki,
.shiki span,
.article pre.shiki {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .shiki,
  :root:not([data-theme='light']) .shiki span {
    color: var(--shiki-dark);
    background-color: var(--shiki-dark-bg);
  }
}

:root[data-theme='light'] .shiki,
:root[data-theme='light'] .shiki span {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}

:root[data-theme='dark'] .shiki,
:root[data-theme='dark'] .shiki span {
  color: var(--shiki-dark);
  background-color: var(--shiki-dark-bg);
}
```

## 6. Plain fallback and inline code

H3's fallback remains:

```html
<pre class="shiki nuvyn-shiki-plain"><code>escaped source</code></pre>
```

It has no Shiki token variables, so H5 explicitly uses existing Nuvyn tokens:

```css
.article pre.shiki.nuvyn-shiki-plain {
  color: var(--text);
  background-color: var(--code-bg);
}
```

The browser regression verifies readable, non-transparent fallback text and
background in the OS-light and OS-dark CSS fallback paths. Inline Markdown
`<code>` remains outside `.shiki`, has no Shiki class, and is not affected by
the Shiki selectors.

## 7. CSS-only theme switching

The Chromium test renders one article, captures its HTML, a `pre.shiki` node, a
token node, token class list, generated style owner and owner text, then calls
the real browser `useTheme().set('dark')` API. It verifies:

```text
article.innerHTML              unchanged
pre.shiki DOM identity         unchanged
representative token identity  unchanged
token class list               unchanged
generated owner identity       unchanged
generated owner text           unchanged
computed token color           changed
computed pre background        changed
```

There is no H5 watcher, render counter, `codeToHtml` call, grammar load or
stylesheet regeneration on theme change.

## 8. Computed-color browser evidence

The dedicated test is:

```text
e2e/markdown-shiki-theme.spec.ts
```

It uses a real `render()` call with a JavaScript fence and an unknown-language
fallback. For a representative token it normalizes the browser's computed
color against the token's `--shiki-light` and `--shiki-dark` values. It performs
the same comparison for `pre.shiki` against `--shiki-light-bg` and
`--shiki-dark-bg`.

The test passed all six selector cases and the CSS-only switch assertion:

```text
1 Chromium test passed
```

For the representative JavaScript keyword, the generated GitHub values resolve
to light `rgb(215, 58, 73)` and dark `rgb(249, 117, 131)` in Chromium; the
background values resolve to light `rgb(255, 255, 255)` and dark
`rgb(36, 41, 46)`. The assertions compare against generated variables rather
than treating these palette values as a hardcoded CSS source of truth.

## 9. H4 security regression

H4's boundary remains unchanged:

```ts
FORBID_ATTR: ['style']
```

The existing browser security test passed after the H5 CSS import. It continues
to prove that Shiki output is class-based, no article `style` attributes or
generated `<style>` element appear, author style/event attributes and unsafe URI
remain blocked, and generated CSS has one `document.head` owner with no user
source sentinel.

No sanitizer option, hook, URI policy, generated owner, transformer or runtime
module was changed by H5.

## 10. Markdown visual and special-fence evidence

The existing visual suite passed without snapshot updates:

```text
e2e/markdown-visual.spec.ts --project=chromium → 2 passed (light/dark)
```

The test still masks only the existing Mermaid/MarkMap widgets. Shiki code is
not masked. H5 did not change MarkMap, Mermaid, `RenderedMarkdown`,
`ReadingPane`, or their theme/mount lifecycle.

## 11. PDF boundary

Reader Shiki theme integration is complete, but PDF Shiki compatibility is not:

```text
live reader → light/dark variables selected by Nuvyn CSS
PDF         → printable-light token proof still belongs to SHIKI-H6
```

H6 must expose the trusted generated CSS within the printable clone and assert
actual nested Shiki token computed colors for reader light, reader dark, forced
dark and OS dark. H5 does not claim that PDF token colors are light. No PDF
source, test, or `PdfExportSurface` file changed in this phase.

## 12. Build / bundle evidence

Validation included:

```text
npm run typecheck → PASS
npm run build     → PASS; 3,930 modules transformed
```

The new static stylesheet is bundled as normal application CSS, while H4's
generated transformer snapshot remains a runtime `document.head` style owner.
Representative Vite output:

| Asset | Raw | Gzip | Observation |
| --- | ---: | ---: | --- |
| `index-BcOhPU8K.js` | 231.72 kB | 77.95 kB | main entry remains effectively flat |
| `VaultView-Br43lkjP.js` | 1,866.55 kB | 533.49 kB | route/runtime chunk |
| `index-B37GQG0h.css` | 133.95 kB | 27.06 kB | includes static `src/shiki.css` |
| `browser-DUg2Jr4t.js` | 206.32 kB | 77.37 kB | Shiki runtime/core async chunk |
| `wasm-BnjxR4X6.js` | 622.32 kB | 232.09 kB | Oniguruma runtime chunk |
| `javascript-Cb010CKM.js` | 174.88 kB | 16.68 kB | lazy JavaScript grammar |
| `typescript-C17ZkDe8.js` | 181.13 kB | 16.28 kB | lazy TypeScript grammar |
| `python-gzcpVVnB.js` | 69.94 kB | 9.09 kB | lazy Python grammar |
| `java-D4RbCvBe.js` | 27.27 kB | 4.30 kB | lazy Java grammar |
| `sql-DGnQv6iD.js` | 23.48 kB | 7.50 kB | lazy SQL grammar |

The build retained existing Rolldown `INVALID_ANNOTATION` and large-chunk
warnings. H5 did not redesign the registry or eagerly load all grammars.

## 13. Validation summary and environment limitation

| Suite | Result |
| --- | --- |
| H1-H4 focused Shiki/Markdown/MarkMap | PASS — 3 files / 82 tests |
| H5 theme browser | PASS — 1 Chromium test |
| H4 security browser | PASS — 1 Chromium test |
| Markdown visual | PASS — 2 Chromium tests |
| PDF export/layout/pagination regression | PASS — 4 Chromium tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 3,930 modules transformed |
| `npm run test:unit` | FAIL — 3 files failed / 21 tests failed; 208 files passed, 3,095 tests passed, 2 skipped |

The default sandbox could not bind the configured Playwright server at
`127.0.0.1:4174` (`listen EPERM`). The browser suites above passed when rerun
with the approved local process permission. This is a test-environment
limitation, not an application failure.

The full unit command is recorded as FAIL, not converted to green evidence. The
19 `server/__tests__/openai-http.test.ts` failures cannot listen on
`127.0.0.1`; the Round-15 and Round-16 child-process cases cannot create their
`tsx` IPC pipes. These are the same server/tsx `EPERM` environment signatures
seen in H0-H4. No Shiki, theme, Markdown, DOMPurify, client, MarkMap, Mermaid or
PDF regression appeared in the run.

## 14. H5 exit criteria

- [x] `src/shiki.css` exists and is imported after generic Nuvyn CSS.
- [x] light and dark token variables are consumed by token spans.
- [x] light and dark background variables are consumed by Shiki blocks.
- [x] explicit light beats OS dark.
- [x] explicit dark beats OS light.
- [x] no-attribute OS light selects light variables.
- [x] no-attribute OS dark selects dark variables.
- [x] `Theme = 'light' | 'dark'` and persistence remain unchanged.
- [x] plain fallback is readable in both palettes.
- [x] inline code remains outside Shiki selectors.
- [x] theme switching changes computed style without changing article HTML.
- [x] pre/token DOM identity and token classes remain unchanged.
- [x] generated owner identity/text remain unchanged on theme switch.
- [x] H4 single-owner and sanitizer security regression remains green.
- [x] MarkMap and Mermaid contracts remain unchanged.
- [x] typecheck and build pass.
- [x] H5 computed-style browser evidence passes.
- [x] H6 PDF implementation has not started.
- [x] H7 highlight.js cleanup has not started.

## 15. H6 handoff

Next phase:

```text
SHIKI-H6 — PDF Compatibility
```

H6 must now prove that the trusted dual-theme stylesheet is visible in the
printable clone and that actual nested Shiki token computed colors are light in
reader light, reader dark, forced dark and OS dark. H5 intentionally leaves
`src/lib/pdfExport.ts`, `PdfExportSurface.vue`, PDF tests and `src/hljs-dark.css`
unchanged.

Current state:

```text
SHIKI-H0: COMPLETE
SHIKI-H1: COMPLETE
SHIKI-H2: COMPLETE
SHIKI-H3: COMPLETE
SHIKI-H4: COMPLETE
SHIKI-H5: COMPLETE
Reader themes: CSS-ONLY
PDF Shiki compatibility: NOT STARTED
highlight.js cleanup: NOT STARTED
```
