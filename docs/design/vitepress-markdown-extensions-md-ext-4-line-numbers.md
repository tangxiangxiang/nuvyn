# Nuvyn VitePress-Style Markdown Extensions
# MD-EXT-4 — Line Numbers

## 1. Phase metadata

| Field | Value |
| --- | --- |
| Phase | MD-EXT-4 — Line Numbers |
| Status | COMPLETE / REVIEW-CLOSED |
| Implementation baseline | `582e312a4c5752a4c9a5c6bba7b0e752b0b78078` |
| Previous phase review closure | `953150f64259b7af389ec0e111d161c9af20b7c7` |
| MD-EXT-4 base | `953150f64259b7af389ec0e111d161c9af20b7c7` |
| Approved PRD | `7e05e3bb43f4283a90ead1abd0c81325bc93281c` |
| Approved Implementation Plan | `582e312a4c5752a4c9a5c6bba7b0e752b0b78078` |
| MD-EXT-4 completion commit | Recorded in the final handoff after this commit is created |
| MD-EXT-4 reader annotation-background follow-up | Recorded in the final handoff after this commit is created |
| Next | MD-EXT-5 — Code Groups — NOT STARTED |

This phase adds only opt-in line-number gutters. MD-EXT-5 code groups and all
later extension phases remain untouched.

## 2. Scope and changed files

The implementation changes are limited to the existing Shiki/Markdown/PDF
surfaces, their focused tests, and the phase documentation:

```text
src/lib/shiki.ts
src/lib/markdown.ts
src/shiki.css
src/lib/pdfExport.ts
src/lib/__tests__/shiki.test.ts
src/lib/__tests__/markdown.test.ts
src/lib/__tests__/pdfExport.test.ts
e2e/markdown-extensions-md-ext-3.spec.ts
e2e/markdown-extensions-md-ext-4.spec.ts
docs/README.md
docs/design/vitepress-markdown-extensions-implementation-plan.md
docs/design/vitepress-markdown-extensions-md-ext-4-line-numbers.md
```

`e2e/markdown-extensions-md-ext-3.spec.ts` only had its old pre-MD-EXT-4
expectation synchronized: its fixture explicitly uses `:line-numbers=10`, so
the browser assertion now expects the approved opt-in gutter instead of
expecting no line-number DOM.

No dependency, FenceMeta parser, sanitizer, server, shared, resource, container,
callout, Mermaid, MarkMap, math, or MD-EXT-5 implementation was added.

## 3. Frozen input contract

MD-EXT-4 reuses the existing `FenceMeta` produced by
`parseFenceMeta(info)`. There is no second metadata parser and no change to
`src/lib/fenceMeta.ts`.

| Fence info | `FenceMeta.lineNumbers` | Start |
| --- | --- | ---: |
| no modifier | `off` | n/a |
| `:no-line-numbers` | `off` | n/a |
| `:line-numbers` | `on` | 1 |
| `:line-numbers=N` with bounded positive `N` | `start` | `N` |
| malformed, zero, negative, non-numeric, or over-bound value | safe malformed/off behavior from FenceMeta | n/a |

The existing bound is `1..100000` (`MAX_LINE_NUMBER_START = 100000`). The
default remains off. Each fence receives its own start; counters are not shared
between code blocks or renders.

The existing exact special-fence branches remain before Shiki preparation:

```text
mermaid → .mermaid-mount
markmap → .markmap-mount
```

They do not receive line-number markup.

## 4. Shiki structural implementation

`src/lib/shiki.ts` adds the named per-fence transformer
`nuvyn:line-numbers`. It is appended after the approved MD-EXT-3 metadata and
source-notation code hooks and before the existing singleton
`transformerStyleToClass` transformer. The style transformer remains last and
continues to own the one trusted generated token stylesheet.

The line transformer:

1. adds the fixed `nuvyn-line-numbers` class to the `<pre>` HAST node;
2. finds Shiki's actual `.line` elements rather than assuming a token shape;
3. preserves all existing annotation classes on the original `.line` element;
4. moves the inter-line separator into the preceding content wrapper so CSS
   grid does not create anonymous blank rows while `textContent` remains useful;
5. wraps original token children without changing their classes or colors; and
6. formats bounded numbers with safe integer handling, including a BigInt
   fallback for the increment operation.

The resulting known-language structure is:

```html
<pre class="shiki nuvyn-line-numbers">
  <code>
    <span class="line">
      <span class="nuvyn-line-number" aria-hidden="true">10</span>
      <span class="nuvyn-line-content">original Shiki token children</span>
    </span>
  </code>
</pre>
```

The number is generated from normalized FenceMeta, not copied from Markdown
source or interpolated into a CSS value. The gutter has only fixed classes and
`aria-hidden="true"`.

## 5. Unknown-language fallback

The normal unnumbered fallback remains the existing escaped
`pre.shiki.nuvyn-shiki-plain` contract. When line numbers are enabled, the
fallback uses the same structural classes as Shiki:

```html
<pre class="shiki nuvyn-shiki-plain nuvyn-line-numbers">
  <code>
    <span class="line">
      <span class="nuvyn-line-number" aria-hidden="true">7</span>
      <span class="nuvyn-line-content">escaped source</span>
    </span>
  </code>
</pre>
```

The fallback normalizes CRLF/CR to logical LF boundaries, escapes the source,
and preserves the logical line count, including the final empty logical line
when the source ends in a newline. It never initializes Shiki for an unknown
language and does not interpret source HTML.

## 6. Empty, newline, and annotation semantics

The implementation follows the installed Shiki 4.4.3 output observed by the
unit tests:

```text
alpha\nbeta       → 2 structural lines
alpha\nbeta\n     → 3 structural lines, final line empty
empty source     → 1 structural line
CRLF source      → same logical line count; fallback has no \r characters
```

Annotation classes remain on their original line. The focused regression proves
that a line containing `[!code error]` keeps its annotation class and token
children after the gutter/content wrappers are inserted. Deferred
`[!code highlight:N]` behavior remains the MD-EXT-3 contract; MD-EXT-4 does not
activate it.

## 7. Reader CSS and accessibility

`src/shiki.css` adds selectors only under
`.article pre.shiki.nuvyn-line-numbers`:

```text
pre        → pre-wrap
code       → block/full available width
.line      → max-content gutter + minmax(0, 1fr) content grid
.nuvyn-line-number  → muted, right-aligned, user-select:none
.nuvyn-line-content → wrapping content column
```

The content column uses `overflow-wrap:anywhere` and `word-break:break-word`
so long lines do not force horizontal clipping. No inline style, CSS custom
property, source-derived selector, or JavaScript theme calculation is used.
Unnumbered Shiki DOM and the default CSS path remain unchanged.

The browser fixture verifies:

```text
gutter text is aria-hidden
no extra aria attributes are created
gutter text is not included in ordinary selection text
code text remains selectable/copyable
theme switching keeps article HTML and node identity
long lines wrap within the code block
default/off fences have no gutter wrappers
```

### Reader annotation-background review follow-up

The original MD-EXT-4 implementation is recorded at:

```text
343c79505f1bb58ab5b619429595ffe7f33bdc04
```

Review found that the generic reader selectors `.shiki span` and their light/
dark theme variants also matched the structural `.nuvyn-line-number` and
`.nuvyn-line-content` spans. Their opaque backgrounds could therefore cover the
semantic annotation background owned by the parent `.line` element.

The follow-up fixes only that reader cascade boundary:

```text
.article pre.shiki.nuvyn-line-numbers .nuvyn-line-number,
.article pre.shiki.nuvyn-line-numbers .nuvyn-line-content
→ background-color: transparent
```

The selector is limited to numbered Shiki surfaces and has sufficient
specificity to win over the generic theme selectors. Annotation classes and
background ownership remain on `.line`; descendant Shiki token spans retain
their existing foreground/background theme variables. There is no DOM,
transformer, PDF, sanitizer, or FenceMeta change.

The MD-EXT-4 browser regression now checks the computed backgrounds of both
structural children under explicit light and dark themes, while also asserting
that the `highlighted` and `error` classes remain on their parent lines. The
review-follow-up completion commit is recorded in the final handoff after this
commit is created.

## 8. Theme and sanitizer boundary

Reader theme changes remain CSS-only. The same rendered token DOM is used for
light, dark, forced, and OS fallback states; no Markdown rerender or Shiki
retokenization occurs.

No sanitizer configuration changed. In particular:

```text
FORBID_ATTR: ['style']  unchanged
```

The new structure uses already-approved `span`, `class`, and `aria-hidden`
attributes. Number text is generated from bounded numeric metadata. The final
article still passes through the existing DOMPurify boundary, and the new
path does not introduce event attributes, arbitrary data attributes, inline
styles, or a style tag in article HTML.

## 9. PDF behavior

`src/lib/pdfExport.ts` reuses the already-rendered numbered spans in the PDF
clone. It does not rerender Markdown, reread resources, or mutate the live
reader. The PDF layout uses the same two-column structural model with printable
light gutter colors and wrapping content.

The existing Shiki PDF selectors continue to force token spans to
`var(--shiki-light)` and `var(--shiki-light-bg)`. The MD-EXT-4 structural
overrides keep the gutter muted and transparent rather than allowing the
generic token selector to paint it as a syntax token. Annotation/background
classes remain structural and token foreground colors remain printable-light.

The browser PDF regression proves:

```text
dark reader → numbered PDF clone uses light token computed colors
custom start 98 → 98, 99, 100
gutter/content widths remain usable
annotation classes survive the clone
live reader line nodes and numbers remain unchanged
the article stylesheet is not copied into the PDF article as a second owner
```

Existing details, Mermaid, MarkMap, pagination, and PDF readiness behavior are
untouched. The PDF layout/pagination/stress suite remains green.

## 10. Test evidence

### Focused unit tests

Command:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/fenceMeta.test.ts \
  src/lib/__tests__/shiki.test.ts \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/markdownContainers.test.ts \
  src/lib/__tests__/callouts.test.ts \
  src/lib/__tests__/pdfExport.test.ts \
  src/composables/vault/__tests__/useMarkdownRender.test.ts \
  src/lib/__tests__/pdf-images.test.ts \
  src/lib/__tests__/pdf-readiness.test.ts
```

Result:

```text
9 test files passed
202 tests passed
```

The jsdom run still prints the repository's `Could not parse CSS stylesheet`
warning; it is not a failing test and did not produce a Markdown/Shiki/PDF
assertion failure.

### Typecheck and build

```text
npm run typecheck → PASS
npm run build     → PASS
```

The build transformed 3933 modules. The known Rolldown `@vueuse/core`
`INVALID_ANNOTATION` warning and the existing >500 kB chunk warnings remain;
no new dependency or eager language catalog was introduced.

### Full unit suite

```text
npm run test:unit → FAIL, baseline-limited
213 test files: 210 passed, 3 failed
3181 tests: 3158 passed, 21 failed, 2 skipped
```

The 21 failures are the known environment-only failures:

```text
19 × server/__tests__/openai-http.test.ts     listen EPERM 127.0.0.1
1  × round15 crash-child test                 tsx IPC listen EPERM
1  × round16 crash-child test                 tsx IPC listen EPERM
```

No Markdown, Shiki, container, callout, client, math, Mermaid/MarkMap, or PDF
product failure appeared in the full suite. The command remains recorded as
FAIL rather than being relabeled PASS.

### Browser and PDF tests

Focused regression command:

```bash
npm run test:e2e -- \
  e2e/markdown-extensions-md-ext-4.spec.ts \
  e2e/markdown-extensions-md-ext-3.spec.ts \
  e2e/markdown-extensions-md-ext-2.spec.ts \
  e2e/markdown-extensions-md-ext-1.spec.ts \
  e2e/markdown-shiki-theme.spec.ts \
  e2e/markdown-shiki-security.spec.ts \
  e2e/pdf-export-shiki.spec.ts \
  e2e/pdf-export.spec.ts
```

Result: `15 passed`.

PDF layout/pagination/stress command:

```bash
npm run test:e2e -- \
  e2e/pdf-export-layout.spec.ts \
  e2e/pdf-export-pagination.spec.ts \
  e2e/pdf-export-stress.spec.ts
```

Result: `9 passed`.

The local web server/browser commands require loopback permission in this
environment. That permission requirement is an execution-environment detail,
not an application failure.

## 11. Bundle evidence

The post-MD-EXT-4 build contains 467 asset files, including 404 JavaScript
assets and 3 CSS assets. The preceding MD-EXT-3 evidence recorded 467 assets,
404 JavaScript assets, and 3 CSS assets.

| Asset surface | MD-EXT-3 baseline | MD-EXT-4 build | Change |
| --- | ---: | ---: | ---: |
| EditorPane JS | 3,648.93 kB / 932.79 kB gzip | 3,648.93 kB / 932.79 kB gzip | 0 |
| VaultView JS | 1,889.19 kB / 540.38 kB gzip | 1,893.05 kB / 541.26 kB gzip | +3.86 / +0.88 kB |
| application entry JS | 231.72 kB / 77.96 kB gzip | 231.72 kB / 77.95 kB gzip | minor gzip variance |
| main CSS | 136.28 kB / 27.56 kB gzip | 136.99 kB / 27.73 kB gzip | +0.71 / +0.17 kB |

The small growth is the structural reader/PDF CSS and line-number integration.
There is no second MarkdownIt, no second Shiki highlighter, no new dependency,
and no eager all-language change. Shiki language/theme chunks remain split.

## 12. Security and architecture checklist

```text
FenceMeta parser reused: YES
second line-number parser: NO
DOMPurify configuration changed: NO
FORBID_ATTR ['style']: UNCHANGED
inline style/CSS custom property: NO
arbitrary class from source: NO
number bound: 1..100000
module-global line counter: NO
Shiki highlighters: ONE
style-to-class owners: ONE
normal default output changed: NO
unknown source escaped: YES
Mermaid/MarkMap path changed: NO
existing containers/callouts changed: NO
MD-EXT-5 code groups: NOT STARTED
copy button: NOT STARTED
resources/includes: NOT STARTED
```

## 13. Rollback boundary and next phase

Reverting MD-EXT-4 removes only:

```text
the nuvyn:line-numbers structural hook
numbered unknown-language fallback wrappers
reader/PDF line-number CSS
MD-EXT-4 tests, E2E fixture, evidence, and lifecycle/index links
```

It preserves H8 Shiki, MD-EXT-1 anchors/TOC/links/images, MD-EXT-2 containers,
MD-EXT-3 annotations and FenceMeta, existing callouts, Mermaid, MarkMap, math,
and the PDF token baseline.

MD-EXT-4 is complete and ready for review. The next phase is:

```text
MD-EXT-5 — Code Groups — NOT STARTED
```
