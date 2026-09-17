# Nuvyn VitePress-Style Markdown Extensions
# MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata

## 1. Evidence metadata

| Field | Value |
| --- | --- |
| Phase | MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata |
| Status | COMPLETE / REVIEW-CLOSED |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Previous phase review closure | aaac9a54a047e504850d497533216d2851c4e928 |
| MD-EXT-3 base | aaac9a54a047e504850d497533216d2851c4e928 |
| Approved PRD | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Approved Implementation Plan | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Shiki | 4.4.3 |
| @shikijs/transformers | 4.4.3 |
| MD-EXT-3 implementation commit | 5b88514f03a60b48cfb2528ccbbf3a375564b6f0 |
| MD-EXT-3 review follow-up commit | Recorded in the final handoff after this evidence commit is created |
| Next phase | MD-EXT-4 — Line Numbers — NOT STARTED |
| Shiki prerequisite | H0-H8 COMPLETE / CLOSED; no H9 |

The commands and test evidence in this document were collected from the
MD-EXT-3 base and implementation working tree. The review follow-up SHA is not
written into the evidence before the commit that creates it.

## 2. Scope and changed files

MD-EXT-3 adds one canonical fence-info metadata model and one separate Shiki
source-notation pipeline. It does not add a visual line-number gutter, code
groups, resource/includes, or any MD-EXT-4+ behavior.

| File | Purpose |
| --- | --- |
| `src/lib/fenceMeta.ts` | Narrow fence-info parser and normalized metadata contract |
| `src/lib/markdown.ts` | Full fence-info reconstruction, discovery integration, and parsed-meta rendering |
| `src/lib/shiki.ts` | Shiki 4.4.3 metadata/notation transformer pipeline and deferred-notation gate |
| `src/shiki.css` | Reader annotation classes without a second token-color system |
| `src/lib/pdfExport.ts` | Printable-light annotation cues in the PDF stylesheet |
| `src/lib/__tests__/fenceMeta.test.ts` | Fence-info grammar, bounds, malformed input, and special-fence tests |
| `src/lib/__tests__/shiki.test.ts` | Transformer order, class output, focus bounds, and deferred `highlight:N` tests |
| `src/lib/__tests__/markdown.test.ts` | Discovery/render integration, metadata-bearing special fences, and container compatibility |
| `src/lib/__tests__/pdfExport.test.ts` | PDF annotation stylesheet and clone behavior assertions |
| `e2e/markdown-extensions-md-ext-3.spec.ts` | Reader, theme, source-notation, metadata, and prepared-PDF browser evidence |
| `docs/design/vitepress-markdown-extensions-implementation-plan.md` | MD-EXT-3 lifecycle and evidence handoff |
| `docs/design/vitepress-markdown-extensions-md-ext-3-code-annotations.md` | This evidence document |
| `docs/README.md` | Design index link |

Forbidden-scope review:

```text
package.json / package-lock.json: unchanged
server/ / shared/: unchanged
src/lib/markdownContainers.ts: unchanged
src/lib/callouts.ts / src/lib/math.ts: unchanged
src/lib/wikiLinks.ts / src/lib/markdownHeadings.ts: unchanged
MD-EXT-4 line-number DOM: not started
MD-EXT-5 code groups: not started
MD-EXT-6 resources/includes: not started
```

## 3. Frozen H8 architecture preserved

The implementation reuses the existing H8 runtime and style ownership:

```text
one lazy Shiki highlighter
one loaded-language/in-flight state model
one transformerStyleToClass instance
one generated style#nuvyn-shiki-generated-styles owner
github-light + github-dark dual themes
defaultColor: false
class-based token output
DOMPurify final article boundary
FORBID_ATTR: ['style'] unchanged
```

No second MarkdownIt instance, highlighter, style registry, renderer, or PDF
rendering path was introduced.

## 4. FenceMeta contract

`parseFenceMeta(info)` receives only the fenced-code info string. Its normalized
contract is:

```ts
interface FenceMeta {
  rawInfo: string
  language: string
  normalizedLanguage: string
  specialFence: 'mermaid' | 'markmap' | null
  highlightRanges: number[]
  lineNumbers: 'off' | 'on' | 'start'
  lineNumberStart?: number
  label?: string
  malformed: string[]
}
```

The parser handles:

```text
language identifier
{1,3-5} and compact range forms
:line-numbers
:no-line-numbers
:line-numbers=N, bounded at 100000
[display label]
malformed metadata diagnostics
```

It has no `notation`, `focus`, `diff`, `warning`, `error`, or source-annotation
field. Source comments are never parsed into `FenceMeta`.

Fence range values are normalized, sorted, deduplicated, bounded, and serialized
back to a safe canonical Shiki meta value such as `{1,3-5}`. Invalid ranges are
recorded as malformed and are not passed to Shiki's range expansion logic.

Special-fence classification is exact and case-sensitive:

```text
mermaid       → special Mermaid mount path
markmap       → special MarkMap mount path
mermaid {1}   → normal language/fallback path, not special
markmap{1}    → normal language/fallback path, not special
Mermaid       → normal language/fallback path, not special
```

MarkdownIt's renderer callback supplies the first info token and remaining
attributes separately. `src/lib/markdown.ts` recombines those callback channels
before invoking `parseFenceMeta`, so metadata-bearing forms cannot accidentally
be reduced to a bare `mermaid` or `markmap` identifier.

## 5. Two independent parsing channels

The implemented flow is deliberately split:

```text
FENCE INFO
"ts {1,3-5}:line-numbers [config.ts]"
        ↓
parseFenceMeta(info)
        ↓
FenceMeta
        ↓
language discovery + Shiki meta range + future block metadata
```

and independently:

```text
CODE SOURCE
const value = 1 // [!code focus:2]
        ↓
Shiki codeToHtml(source, ...)
        ↓
approved source-notation transformers
        ↓
fixed structural annotation classes
```

`FenceMeta` is per fence/per render and is consumed by language discovery,
special-fence classification, normal fence rendering, and Shiki meta ranges.
Source notation is consumed per `codeToHtml` call and is not stored in the
fence-info metadata object.

## 5.1 Review follow-up — source fidelity and range work budget

The review follow-up closes two parser-boundary findings without changing the
MD-EXT-3 feature scope.

Deferred source-notation gating now selects a per-`codeToHtml` invocation,
collision-free marker. Candidate markers are checked against the complete
author source before the gate transformer is created, and the restore
transformer closes over the exact marker selected for that invocation. The
previous fixed public sentinel is no longer used. Consequently:

```text
author-authored [!code nuvyn-deferred-notation ...] text → source-preserved
gate-inserted marker → restored only by its own invocation
marker leakage → absent
concurrent invocation cross-restore → absent
```

Fence range expansion now has a second bound in addition to
`MAX_HIGHLIGHT_RANGE_LINE = 100000`:

```text
MAX_HIGHLIGHT_EXPANSION_WORK = 100000
scope = one parseFenceMeta(info) call
```

Each range token is validated and charged atomically before its values are
expanded. Duplicate ranges consume the same work budget as unique ranges. A
token that exceeds the remaining budget is recorded in `malformed` and skipped
as a whole; previously accepted tokens remain deterministic, sorted, and
deduplicated.

## 6. Installed Shiki 4.4.3 evidence

The installed transformer exports and observed output were inspected directly,
not reimplemented from memory. The production transformer order is:

```text
@shikijs/transformers:meta-highlight
nuvyn:source-notation-scope-gate
@shikijs/transformers:notation-highlight
@shikijs/transformers:notation-focus
@shikijs/transformers:notation-diff
@shikijs/transformers:notation-error-level
nuvyn:source-notation-scope-restore
@shikijs/transformers:style-to-class
```

The final `style-to-class` entry is the existing singleton H8 transformer. The
Nuvyn gate and restore transformers do not create a runtime or CSS owner.

Approved source notation produces the installed structural classes:

```text
[!code highlight] → highlighted
[!code focus]     → focused
[!code focus:N]   → focused range
[!code ++]        → diff add
[!code --]        → diff remove
[!code warning]   → warning / highlighted
[!code error]     → error / highlighted
[!code info]      → info / highlighted
```

`transformerMetaHighlight` receives only the canonical, validated range string
from `FenceMeta`, never the raw untrusted info string.

## 7. Deferred notation and bounds

The installed notation transformer also supports range/case variants outside the
approved initial product contract. A source-level Nuvyn gate temporarily marks
those forms as deferred before official notation processing, and a later code
hook restores them as ordinary source text. This keeps the marker visible and
prevents accidental activation.

```text
[!code highlight:N] → deferred; not activated
[!code hl]         → deferred; not activated
[!code Highlight]  → deferred; not activated
[!code focus:0]    → deferred; not activated
[!code focus:-1]   → deferred; not activated
[!code focus:abc]  → deferred; not activated
[!code focus:1001] → deferred; not activated
```

The approved `focus:N` bound is a positive integer from `1` through `1000`.
Malformed source notation never generates an arbitrary class, style, or HTML
attribute. `highlight:N` remains deferred at the source-notation boundary; it is
not detected by `parseFenceMeta(info)`.

## 8. Renderer and compatibility flow

The current render path is:

```text
raw Markdown
    ↓
getMd() → one MarkdownIt singleton
    ↓
md.parse(markdown, isolated discovery env)
    ↓
discoverFenceMetas()
    ↓
prepareShikiLanguages(FenceMeta[])
    ↓
fresh real WikiLink env
    ↓
md.render(markdown, env)
    ↓
full fence info → FenceMeta
    ├─ exact bare mermaid/markmap → existing mount placeholder
    └─ normal fence → Shiki annotation pipeline / escaped plain fallback
    ↓
DOMPurify
    ↓
Vue v-html
```

Fences inside MD-EXT-2 containers continue through the same path. Existing
callouts, headings/TOC, WikiLinks, math, Mermaid, MarkMap, and lazy images remain
owned by their existing plugins and mount paths. No line-number DOM or code-group
tab DOM was introduced.

## 9. Security and sanitizer evidence

The sanitizer configuration is unchanged:

```text
FORBID_ATTR: ['style']
```

Generated annotation classes are fixed Shiki/Nuvyn output and remain inside the
sanitized article HTML. Generated token CSS remains in the trusted head owner,
never in user content. User source, raw HTML, source notation, and fence metadata
remain untrusted. No generic attributes, event attributes, arbitrary data
attributes, inline styles, or source-derived selectors were added.

Focused Markdown/Shiki and browser security tests continue to prove:

```text
style attributes: removed
event handlers: removed
script/style/unsafe tags: removed
unknown data-* attributes: blocked
Shiki token classes: retained
generated stylesheet: one head owner
generated stylesheet: absent from article HTML
```

## 10. Reader CSS and theme behavior

`src/shiki.css` adds fixed selectors for:

```text
.line.highlighted
.line.focused
.line.diff.add
.line.diff.remove
.line.warning
.line.error
.line.info
```

The selectors add line-level background/border cues and preserve Shiki token
foreground variables. They do not set token colors and do not alter code layout
for unannotated fences. Focus uses the official `has-focused` state to visually
de-emphasize non-focused lines. Theme switching remains CSS-only; browser
coverage confirms annotated DOM identity remains stable while the reader theme
changes.

## 11. PDF behavior

`src/lib/pdfExport.ts` adds printable-light annotation selectors under the
existing `.pdf-document .article` boundary. They provide light background/border
cues for highlighted, focused, diff, warning, error, and info lines without
overriding Shiki token foreground colors. The existing PDF token rules still force
`var(--shiki-light)` and `var(--shiki-light-bg)`.

Generated custom details are expanded only on the prepared PDF clone. The live
reader's `details.open` state is not mutated, and raw author `<details>` elements
remain outside this MD-EXT-2-owned expansion selector.

The existing PDF Shiki matrix passed for explicit light, explicit dark, and OS
fallback states; each clone still uses the printable-light token palette. The
new browser regression additionally verifies an error annotation and its
printable line cue on the prepared PDF surface.

## 12. Test evidence

### Focused unit tests

```text
10 test files passed
222 tests passed
```

The focused assertions cover metadata-bearing language discovery, exact special
fences, all approved notation classes, `focus:N` bounds, deferred
`highlight:N`, invocation-local source fidelity, total range-expansion budget,
no line-number DOM, container nesting, sanitizer behavior, PDF clone details,
and stylesheet ownership.

### Typecheck and build

```text
npm run typecheck → PASS
npm run build     → PASS — 3,933 modules transformed
```

The build retains the existing Rolldown `INVALID_ANNOTATION` warnings from
`@vueuse/core` and existing large-chunk warnings. No warning was hidden or
reclassified as a pass.

### Focused browser/PDF tests

```text
14 tests passed
```

The first sandbox-only browser attempt could not bind `127.0.0.1:4174`; the
same suite passed with the controlled local web-server permission. This is an
environment limitation, not a product test result.

### Full unit suite

```text
npm run test:unit → FAIL, exit code 1
Test Files: 3 failed | 210 passed (213)
Tests: 21 failed | 3154 passed | 2 skipped (3177)
```

The 21 failures are the same pre-existing environment class recorded by the
previous phase:

```text
19 server openai-http tests: loopback listen EPERM
1 Round-15 crash child: tsx IPC listen EPERM
1 Round-16 crash child: tsx IPC listen EPERM
```

No Markdown, Shiki, container, callout, client, math, or PDF product failure
appeared in the full suite. The command is recorded as FAIL rather than being
renamed PASS.

## 13. Bundle evidence

The post-MD-EXT-3 production build contains 467 asset files, including 404
JavaScript assets and 3 CSS assets. Representative Vite output:

| Asset | Raw | Gzip | Role |
| --- | ---: | ---: | --- |
| `EditorPane-MpiorUPt.js` | 3,648.93 kB | 932.79 kB | editor surface |
| `VaultView-DBiyl9tE.js` | 1,889.19 kB | 540.38 kB | reader/vault surface |
| `index-CfGZ6jSD.js` | 231.72 kB | 77.96 kB | application entry |
| `index-C83VMdUW.css` | 136.28 kB | 27.56 kB | main CSS |

The MD-EXT-2 baseline recorded 467 assets, 1,877.15 kB VaultView, and 135.57
kB main CSS. The current growth is localized to the annotation/runtime/CSS
changes; no dependency, eager all-language catalog, second highlighter, or
second MarkdownIt was introduced. Shiki language chunks remain split by
language.

## 14. Concurrency and state

```text
highlighter: existing singleton
style transformer: existing singleton
generated CSS owner: one
FenceMeta: per fence/per render
source notation: per codeToHtml invocation
language preparation: existing canonical/in-flight deduplication
module-global notation state: none
render-scoped WikiResolver preflight: isolated as before
```

The new gate/restore transformers are stateless. They do not mutate the shared
language registry, highlighter promise, or stylesheet owner.

## 15. Rollback boundary

Reverting MD-EXT-3 removes:

```text
FenceMeta parser and discovery wiring
approved source-notation transformers and deferred gate
annotation reader/PDF selectors
MD-EXT-3 tests, E2E, evidence, and lifecycle/index links
```

It retains the H8 normal Shiki renderer, singleton/runtime retry behavior,
generated CSS owner, MD-EXT-1/2 behavior, existing callouts, math, Mermaid,
MarkMap, and the existing PDF token baseline. MD-EXT-4 has no dependency on a
second parser or runtime and remains independently reviewable.

## 16. Exit criteria

```text
Fence-info parser only: PASS
Source-notation transformer channel separate: PASS
Invocation-local deferred marker/source fidelity: PASS
Per-parse total range work budget: PASS
Approved annotation classes: PASS
focus:N bounded at 1000: PASS
highlight:N deferred: PASS
exact Mermaid/MarkMap special fences: PASS
metadata-bearing special fences not mounted: PASS
class-only output / style forbidden: PASS
single Shiki/style owner: PASS
reader theme identity: PASS
printable-light PDF token path: PASS
PDF clone details and reader isolation: PASS
focused unit: PASS
typecheck: PASS
build: PASS
focused browser/PDF: PASS
full unit: BASELINE-LIMITED; no new product regression
dependencies/server/shared: unchanged
MD-EXT-4: NOT STARTED
```

## 17. Next phase

MD-EXT-3 is complete and review-closed. Only after review approval should
implementation begin for:

```text
MD-EXT-4 — Line Numbers
```
