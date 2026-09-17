# Nuvyn Shiki H6 — PDF Compatibility

本记录是 SHIKI-H6 的实现与验证证据。H6 只把已经生成的 Shiki
class-based CSS snapshot 接入现有 PDF trusted style boundary，并证明 printable
clone 中的嵌套 token 使用 GitHub-light palette。H6 不重新解析 Markdown、不重新
tokenize、不创建第二个 Shiki runtime，也不开始 H7 的 highlight.js 清理。

## 1. Phase metadata

| Item | Evidence |
| --- | --- |
| Phase | `SHIKI-H6 — PDF Compatibility` |
| H6 base / H5 completion | `9d5d8a9ae0e19ee833f199784c9c5616cb02f237` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| H5 completion commit | `9d5d8a9ae0e19ee833f199784c9c5616cb02f237` |
| H6 implementation commit | `6caa4f013e1887e2d3a6cb63450c1a9e33a0c9b2` |
| Runtime | Node `v24.15.0`, npm `11.12.1`; Docker baseline remains `node:22-bookworm-slim` |
| Status | `SHIKI-H6 — COMPLETE`; H7/H8 not started |
| Scope | PDF trusted stylesheet, clone visibility, printable-light token colors, plain fallback, layout/pagination/widget regressions |

H6 uses current main at the H5 completion commit. The historical implementation
baseline remains unchanged. `highlight.js`, `src/hljs-dark.css` and the reader
theme implementation remain available for the independent H7 cleanup boundary.

## 2. PDF pipeline baseline

The existing PDF flow remains the source of the article HTML:

```text
PdfExportSurface / RenderedMarkdown
    ↓
Shiki class-based article HTML already rendered by MarkdownIt
    ↓
wait for math/Mermaid/MarkMap/image settlement
    ↓
preparePdfArticleHtml(article)
    ↓
createPdfDownloadElement(articleHtml)
    ↓
html2pdf → html2canvas clone → jsPDF download
    ↓
finally remove .pdf-download-host and .pdf-download-root
```

`PdfExportSurface.vue` still passes `render-theme="light"`. That prop is consumed
by the Mermaid/MarkMap enhancement paths; it does not change
`document.documentElement[data-theme]` and is not used as the Shiki PDF theme
mechanism.

H6 does not call `render()` again during export and does not call `codeToHtml()`
from `pdfExport.ts`. The PDF receives the already-rendered `pre.shiki` markup and
its generated token classes.

## 3. Generated CSS snapshot handoff

The only Shiki API imported by `src/lib/pdfExport.ts` is:

```ts
getGeneratedShikiCss()
```

At the start of `downloadPdfDocument()` H6 captures:

```text
const pdfStylesText =
  getGeneratedShikiCss() + PDF_DOWNLOAD_STYLES
```

The actual implementation filters an empty generated snapshot and joins the
trusted pieces without accepting caller-provided CSS. The snapshot is immutable
for one export transaction. A concurrent Markdown render may update the live
head owner later, but it cannot change a PDF already being cloned.

The handoff contract is:

| Contract | H6 result |
| --- | --- |
| PDF Shiki CSS source | `getGeneratedShikiCss()` |
| Snapshot timing | once per export |
| Second transformer | NO |
| Second highlighter | NO |
| Second language registry | NO |
| Generated CSS owner in PDF | `style#nuvyn-pdf-download-styles` |
| Generated CSS owner in live reader | separate `style#nuvyn-shiki-generated-styles` |
| PDF copy of live owner | NO; CSS text is copied into the PDF owner |

The generated snapshot contains only trusted theme-variable declarations emitted
by the one H4 `transformerStyleToClass` instance. It is not assembled from
Markdown source, code source, title, fence metadata, language input or resolver
output.

## 4. Trusted PDF stylesheet boundary

`createPdfDownloadElement()` continues to create one PDF root and one trusted
style element:

```text
.pdf-download-root
└── style#nuvyn-pdf-download-styles
```

The source article is inserted below the root as HTML. The PDF style is not put
inside `articleHtml`, and the prepared article does not contain a PDF stylesheet
owner. Unit coverage also places `NUVYN_H6_USER_SOURCE_SENTINEL` in article code
and proves it remains article text while it does not enter stylesheet text.

Public `PdfDownloadOptions` remains exactly the existing `{ title, articleHtml }`
contract. No `generatedCss`, `styles` or `customCss` option was added.

## 5. html2canvas clone contract

The existing `html2canvas.onclone` layout normalization now also calls the
internal PDF stylesheet repair with the exact snapshot captured before export.
The repair:

1. finds a direct `style#nuvyn-pdf-download-styles` child of the cloned PDF root;
2. creates it when the clone omitted the source style;
3. replaces stale text with the complete captured snapshot;
4. removes duplicate direct owners;
5. keeps the existing normal-flow layout normalization;
6. invokes only the narrow `__testing__.setPdfCloneObserver()` seam after repair.

The observer is not a public export option and has no production behavior when it
is unset. `downloadPdfDocument()` clears it in `finally`, including failed PDF
transactions, so test state cannot leak across exports.

The clone is allowed to retain a dark `data-theme` attribute. H6 does not set the
clone or live document theme to light. The scoped PDF selectors and `!important`
rules are the isolation boundary.

Unit coverage proves all three clone cases:

| Clone input | Result |
| --- | --- |
| existing correct owner | one owner, complete snapshot retained |
| missing owner | one owner recreated with complete snapshot |
| stale owner text | one owner replaced with complete snapshot |

## 6. Printable light Shiki selectors

The PDF stylesheet keeps the existing generic `pre` wrapping, border and
pagination rules, then adds the Shiki-specific printable layer:

```css
.pdf-document .article pre.shiki:not(.nuvyn-shiki-plain) {
  color: var(--shiki-light) !important;
  background-color: var(--shiki-light-bg) !important;
}

.pdf-document .article pre.shiki:not(.nuvyn-shiki-plain) span {
  color: var(--shiki-light) !important;
  background-color: var(--shiki-light-bg) !important;
}

.pdf-document .article pre.shiki.nuvyn-shiki-plain,
.pdf-document .article pre.shiki.nuvyn-shiki-plain span {
  color: #202124 !important;
  background-color: #f5f6f8 !important;
}
```

The span rule reads each token span's own inherited `--shiki-light` custom
property. It does not flatten every token to `#202124`. The generated CSS still
contains `--shiki-dark` definitions because the same trusted dual-theme snapshot
is used by the reader; the final PDF declarations consume only the light values.

The H6 selectors are scoped to `.shiki` and do not target Mermaid SVG text,
MarkMap nodes, or generic author content.

## 7. Multi-color token proof

The dedicated browser test is:

```text
e2e/pdf-export-shiki.spec.ts
```

It renders the real Markdown path, calls the production PDF export, observes the
actual `html2canvas.onclone` document, and compares normalized browser computed
colors with each token's `--shiki-light` and `--shiki-dark` values.

Representative GitHub theme values observed by the browser path include:

| Context | Light variable | Dark variable | Reader dark computed | PDF clone computed |
| --- | --- | --- | --- | --- |
| JavaScript keyword | `rgb(215, 58, 73)` | `rgb(249, 117, 131)` | dark variable | light variable |
| JavaScript string | `rgb(3, 47, 98)` | `rgb(158, 203, 255)` | dark variable | light variable |
| Shiki pre background | `rgb(255, 255, 255)` | `rgb(36, 41, 46)` | dark background | light background |

The assertions additionally require at least two distinct light token colors.
The dark-reader export in `e2e/pdf-export.spec.ts` repeats the clone assertion
against the Kitchen Sink's Java block. Therefore H6 proves both:

```text
computed token color == its own light variable
computed token color != its dark variable
light token A != light token B
```

## 8. Plain fallback PDF behavior

Unknown-language output remains:

```html
<pre class="shiki nuvyn-shiki-plain"><code>escaped source</code></pre>
```

The PDF style explicitly gives this block a dark printable text color and a
light `#f5f6f8` surface. The dedicated fixture contains an unknown fence and the
clone test asserts both values are non-empty and non-transparent.

The H5 browser regression was also tightened so fallback text/background
readability is asserted explicitly in both reader states:

```text
forced light reader → fallback color/background readable
forced dark reader  → fallback color/background readable
```

## 9. Theme isolation matrix

The H6 browser matrix uses the production PDF download helper for each case:

| Reader / environment | Live reader | PDF Shiki |
| --- | --- | --- |
| explicit light + OS light | light | light |
| explicit light + OS dark | light | light |
| explicit dark + OS light | dark | light |
| explicit dark + OS dark | dark | light |
| no attribute + OS dark fallback | dark | light |

The final row removes the persisted theme attribute and emulates OS dark. It is
CSS isolation evidence, not a new persistent `system` theme state.

## 10. Reader-vs-PDF computed-style evidence

For each matrix case the browser records:

```text
live reader representative token palette
live reader Shiki head-owner identity/text
clone token light/dark variables and computed color
clone pre light/dark variables and computed background
clone data-theme attribute
PDF style owner count and text
plain fallback color/background
```

The dark-reader cases prove the intended separation:

| Context | Token palette | Theme mutation |
| --- | --- | --- |
| live reader | dark | none |
| PDF clone | light | clone html is not rewritten |
| live head owner | unchanged identity/text | no copy/ownership transfer |

The observer also proves that the clone contains zero
`style#nuvyn-shiki-generated-styles` elements and exactly one
`style#nuvyn-pdf-download-styles`.

## 11. Code wrapping evidence

The focused fixture contains a long unbroken JavaScript string. Existing PDF
rules remain in force:

```text
pre                 → white-space: pre-wrap
pre                 → overflow-wrap: anywhere
pre code            → white-space: inherit
pre code            → word-break: break-word
```

`e2e/pdf-export-layout.spec.ts` passed with no horizontal overflow. The existing
huge-code stress lane also passed with `clientWidth === scrollWidth` and `breakInside: auto`
after the existing oversized-block logic marked the block splittable.

## 12. Pagination evidence

H6 does not change the existing pagination model:

```text
ordinary/short block → break-inside: avoid
genuinely oversized block → .pdf-allow-split → break-inside: auto
```

The ordinary boundary fixture passed, including its pre-existing boundary
diagnostics. The layout and 100-page stress lanes passed, and no Shiki rule adds
`pdf-allow-split` or overrides the existing split class.

## 13. Mermaid / MarkMap regression

No Mermaid, MarkMap, `PdfExportSurface.vue`, `RenderedMarkdown.vue` or widget
staticization code was changed. Existing export behavior remains:

```text
render-theme="light" → widget mount/theme path only
prepareMermaidSvg()   → static PDF SVG
prepareMarkmapSvg()   → static fitted PDF SVG
```

The existing Kitchen Sink export and extreme Mermaid/MarkMap stress lanes passed.
The Shiki selectors are restricted to `.shiki`, so SVG text and MarkMap nodes
are outside the new PDF color rules.

## 14. Export cleanup / failure evidence

The existing success and failure cleanup tests remain green:

```text
success → .pdf-download-root and .pdf-download-host removed
failure → .pdf-download-root and .pdf-download-host removed
```

The live Shiki head owner remains present and unchanged during the unit snapshot
test and the browser dark-reader export. The global `data-theme` remains the
same before and after export. The test-only clone observer is cleared from the
module-level seam in `finally`.

## 15. Security boundary

The Markdown sanitizer remains unchanged:

```ts
FORBID_ATTR: ['style']
```

H6 adds no inline styles to Shiki article tokens and does not broaden
`PdfDownloadOptions`. Generated CSS is trusted infrastructure composed only from:

```text
getGeneratedShikiCss()
PDF_DOWNLOAD_STYLES
```

The PDF stylesheet is outside `articleHtml`. User code/source remains article
text and is not concatenated into CSS. H4 security browser coverage still passes.

## 16. Unit / browser / E2E results

| Command / suite | Result |
| --- | --- |
| PDF unit `pdfExport.test.ts` | PASS — 14 tests |
| H6 focused unit: Shiki/Markdown/MarkMap/PDF-readiness/PDF export | PASS — 5 files, 123 tests |
| H6 clone theme matrix `pdf-export-shiki.spec.ts` | PASS — 1 test, 5 theme cases |
| H4 security browser | PASS — 1 Chromium test |
| H5 theme browser | PASS — 1 Chromium test; fallback light/dark assertions included |
| dark-reader Kitchen Sink PDF export | PASS — 2 PDF tests in `pdf-export.spec.ts` |
| PDF layout/pagination/stress | PASS — 9 Chromium tests |
| Markdown visual | PASS — 2 Chromium tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 3,930 modules transformed |
| `npm run test:unit` | FAIL — 3 files failed; 21 tests failed, 208 files passed, 3,098 tests passed, 2 skipped |

The full-unit failure is recorded honestly. The 19 `server/__tests__/openai-http.test.ts`
failures are `listen EPERM 127.0.0.1`; the Round-15 and Round-16 failures are the
same pre-existing `tsx` IPC pipe `listen EPERM` signatures recorded in H0-H5.
Focused Shiki, Markdown, PDF, DOMPurify, client, resolver, Mermaid and MarkMap
tests introduced no new failures.

The build retains the existing Rolldown `INVALID_ANNOTATION` and large-chunk
warnings. H6 adds no Shiki runtime, language registry, transformer or theme
chunk; the existing lazy grammar assets remain split (for example JavaScript,
TypeScript, Java, Python and SQL chunks).

## 17. H6 exit criteria

- [x] PDF reads the existing trusted `getGeneratedShikiCss()` snapshot.
- [x] Snapshot is captured once per export transaction.
- [x] No second transformer, highlighter or language registry exists.
- [x] Public PDF options do not accept arbitrary CSS.
- [x] One `style#nuvyn-pdf-download-styles` remains the PDF owner.
- [x] `style#nuvyn-shiki-generated-styles` is not copied into the PDF root.
- [x] Generated Shiki class definitions are present in the PDF owner.
- [x] PDF selectors consume `--shiki-light` and `--shiki-light-bg`.
- [x] Nested token computed colors equal their light variables.
- [x] At least two distinct syntax token colors remain distinct.
- [x] Dark token values do not leak into the PDF clone.
- [x] Reader light/dark/forced/OS-dark matrix all produce light PDF tokens.
- [x] Live `data-theme`, article HTML and head owner remain unchanged.
- [x] Missing/stale clone style repair is unit-tested.
- [x] Plain fallback is readable in reader and PDF paths.
- [x] Long-line wrapping and horizontal clipping regressions pass.
- [x] Short-block keep-together and oversized-block splitting pass.
- [x] Mermaid, MarkMap, pagination and stress regressions pass.
- [x] Success/failure cleanup remains intact.
- [x] `FORBID_ATTR: ['style']` remains unchanged.
- [x] H7 highlight.js cleanup has not started.

## 18. H7 handoff

H6 is complete. The next phase is:

```text
SHIKI-H7 — Cleanup & highlight.js Removal
```

H7 may now review and remove Nuvyn-owned highlight.js imports, the direct
dependency and `src/hljs-dark.css`, while separately preserving/classifying
MarkMap-owned `features.hljs` and transitive dependency references. H7 must not
remove the generated Shiki CSS owner, PDF snapshot boundary, or PDF-specific
light selectors.

Current state:

```text
SHIKI-H0: COMPLETE
SHIKI-H1: COMPLETE
SHIKI-H2: COMPLETE
SHIKI-H3: COMPLETE
SHIKI-H4: COMPLETE
SHIKI-H5: COMPLETE
SHIKI-H6: COMPLETE

Normal renderer: SHIKI
Reader theme: CSS-ONLY LIGHT/DARK
PDF theme: ALWAYS PRINTABLE LIGHT
PDF nested syntax colors: PROVEN LIGHT + MULTI-COLOR
Reader/global theme mutation: NONE
PDF wrap/pagination/widgets: PRESERVED
highlight.js cleanup: NOT STARTED
Next: SHIKI-H7 — Cleanup & highlight.js Removal
```
