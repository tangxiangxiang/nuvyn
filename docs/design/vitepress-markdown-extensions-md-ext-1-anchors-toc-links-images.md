# Nuvyn VitePress-Style Markdown Extensions — MD-EXT-1
# Anchors, TOC, Links & Lazy Images

## 1. Evidence metadata

| Field | Value |
| --- | --- |
| Phase | MD-EXT-1 — Anchors, TOC, Links & Lazy Images |
| Status | COMPLETE / REVIEW-CLOSED |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Previous phase completion | 579bda1850ceb955eb0796fec2cc3ec919b72a21 |
| MD-EXT-1 base | 579bda1850ceb955eb0796fec2cc3ec919b72a21 |
| Approved PRD | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Approved Implementation Plan | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| MD-EXT-1 completion commit | Recorded in the final handoff after this evidence commit is created |
| MD-EXT-1 review follow-up | Recorded in the final handoff after this corrective commit is created |
| Next phase | MD-EXT-2 — Custom Containers — NOT STARTED |
| Shiki prerequisite | H0-H8 COMPLETE / CLOSED; no H9 |

This evidence was produced on top of the MD-EXT-0 completion commit. The immutable
implementation baseline remains 582e312; the phase base is the later MD-EXT-0
evidence commit 579bda. No dependency or lockfile change was made.

## 2. Scope and ownership

Implemented only:

- narrow custom heading anchors;
- one final per-render heading-ID allocator;
- standalone case-sensitive [[toc]] for h2-h4;
- generated Markdown/linkify HTTP(S) external-link attributes;
- loading="lazy" for Markdown-generated images;
- reader, sanitizer, PDF, and browser regression coverage.

The phase did not implement containers, fence metadata, Shiki annotations, line
numbers, code groups, resources/includes, or any server route. Existing Shiki,
Mermaid, MarkMap, math, callout, WikiLink, and PDF theme contracts remain in place.

## 3. Heading-ID architecture

src/lib/markdownHeadings.ts owns only the narrow final {#safe-id} suffix and TOC
bookkeeping. Its safe explicit-ID grammar is:

    {#<ASCII letter><ASCII letter/digit/._:->{0,127}}

The suffix is authorized from the original inline source (`inline.content`) before
looking at the rendered children. This prevents an escaped opener (`\{#id}`) or an
entity-produced visible opener (`&#123;#id}`) from becoming metadata merely because
the post-inline text resembles `{#id}`. An even backslash pair follows Markdown's
escape semantics; an odd run keeps the opener literal. After source authorization,
only the corresponding rendered suffix is removed, while preceding
strong/emphasis/code/emoji/link tokens are preserved. Class, style, event, empty,
whitespace, and other generic attribute forms are not accepted.

The rule order is:

    MarkdownIt block parse
        ↓
    nuvyn_heading_metadata core rule before markdown-it-anchor
        ↓
    markdown-it-anchor
        ↓
    nuvyn_toc_finalize core rule after markdown-it-anchor

The anchor configuration uses the existing Nuvyn automatic slug behavior plus:

    slugifyWithState: slugifyHeadingWithState
    uniqueSlugStartIndex: 2

The explicit-ID queue and collision state are stored in the current render env.
Thus automatic IDs, explicit IDs, auto/custom collisions, permalink hrefs, reader
page-nav extraction, TOC hrefs, and PDF clone anchors all use the same allocator.
There is no module-global slugger and concurrent renders do not share collision
state.

Verified collision contract:

| Markdown | Final IDs |
| --- | --- |
| three automatic Hello headings | hello, hello-2, hello-3 |
| Hello, then Other {#hello} | hello, hello-2 |
| First {#hello}, then Hello | hello, hello-2 |
| First {#x}, then Second {#x} | x, x-2 |
| Hello, Other {#hello}, Hello | hello, hello-2, hello-3 |

Source-awareness cases are also fixed: `## Example \{#literal}` and
`## Entity &#123;#literal}` retain the visible `{#literal}` text and receive normal
automatic IDs; a real final `{#id}` remains explicit. A final suffix in
`## Heading {#one} {#two}` uses only `two` as metadata and leaves `{#one}` visible.

## 4. TOC architecture

[[toc]] is recognized by a narrow block rule only when the complete source line,
after surrounding whitespace trimming, is exactly lower-case [[toc]]. Upper-case,
inline, code-span, and fenced occurrences remain ordinary content.

The TOC finalization rule runs after markdown-it-anchor, reads the final id from
heading-open tokens, and collects only h2, h3, and h4. It builds a nested static
list and renders a nav.nuvyn-toc with role="navigation" and
aria-label="Table of contents".

Labels are derived from inline tokens as escaped text. Raw HTML tags are never copied
into the generated TOC. The TOC does not parse Markdown again, create a second
slugger, or invoke the WikiResolver. A heading containing a WikiLink therefore
causes only the real render's resolver call.

The reader uses the existing final-HTML heading extraction for page navigation. PDF
preparation preserves the same IDs and static TOC fragment links; it does not create
a separate PDF slugging path.

The sanitizer delta is limited to nav in ALLOWED_TAGS and aria-label in ALLOWED_ATTR.
Existing FORBID_ATTR: ['style'], event-attribute removal, URI validation, and
data-attribute restrictions are unchanged. Generated external target preservation
uses a temporary opaque per-render provenance value; the value is removed before
sanitization returns and is not a public data-attribute allowance.

Sanitizer before/after ledger:

| Surface | Before MD-EXT-1 | After MD-EXT-1 |
| --- | --- | --- |
| TOC nav | nav not allowed | generated nav allowed |
| TOC label | aria-label not allowed | generated aria-label allowed |
| Generated external target | target was configured but `_blank` was removed by the runtime URI check | only a matching per-render opaque provenance marker can preserve `_blank`; the marker is stripped |
| Image lazy hint | loading already allowed | no sanitizer expansion |
| User style/events/unsafe URI | existing removal policy | unchanged |

## 5. Generated external-link policy

The existing wikiLinks.ts link_open renderer now composes two classifications on
one token and calls the final renderer once:

    existing WikiLink/.md/internal classification
        ↓
    generated external classification
        ↓
    renderToken once

Only Nuvyn-generated Markdown links and MarkdownIt linkify output whose final href
is HTTP(S) receive target="_blank" and rel="noopener noreferrer".

The generated token may retain the stable nuvyn-external-link class for presentation
and classification. That class is author-forgeable and is not a security marker.
Instead, render() creates an opaque secure-random token for that render, passes it
through the final MarkdownIt env, and the generated link_open renderer adds a
temporary internal marker containing the token. The sanitizer recognizes a marker
only when it matches the current render's token and the element is an HTTP(S)
anchor with target="_blank". It normalizes the trusted generated rel to
noopener noreferrer, removes the temporary marker, and returns no provenance value
in reader/PDF/copyable HTML. A separate sanitizer context cannot authorize another
render's marker.

Internal .md, relative, fragment, WikiLink, mailto:, and tel: links are not external
policy targets. Raw semantic HTML anchors do not pass through the generated
link_open renderer and keep the existing sanitizer behavior, even if an author
forges the stable class or guesses the marker attribute. DOMPurify still does not
allow arbitrary target values. FORBID_ATTR: ['style'] remains exact.

## 6. Markdown images and PDF readiness

The existing MarkdownIt image renderer is wrapped rather than replaced. It adds
loading="lazy" only to image tokens produced by Markdown syntax and preserves src,
alt, title, and the existing URI sanitizer contract. Raw HTML img elements remain
unchanged.

The first PDF export run exposed a real readiness regression: a lazy image in the
dedicated PDF surface could remain outside browser lazy-load heuristics and prevent
the existing image waiter from reaching a settled outcome. The smallest
phase-owned correction is in src/lib/pdf-images.ts: before waiting, a PDF-surface
image with loading="lazy" is promoted to loading="eager". This does not mutate the
reader output, reread a resource, or change the Markdown renderer's lazy contract;
the export surface is discarded after the operation.

PDF also receives narrowly scoped static TOC styles. The prepared article retains
heading IDs, TOC hrefs, and the Markdown image element. Existing printable-light
theme, widget readiness, cleanup, pagination, and no-resource-reread behavior remain
the owners of the rest of PDF export.

## 7. Changed files

| File | Role |
| --- | --- |
| src/lib/markdownHeadings.ts | Per-render custom IDs, anchor metadata, TOC rule/finalization/rendering |
| src/lib/markdown.ts | Anchor/TOC registration, render-scoped provenance sanitizer, Markdown image renderer |
| src/lib/wikiLinks.ts | Composed generated external-link policy |
| src/style.css | Reader TOC presentation |
| src/lib/pdfExport.ts | Printable static TOC styles |
| src/lib/pdf-images.ts | PDF-only lazy-image readiness promotion |
| src/lib/__tests__/markdown.test.ts | Anchor, TOC, link, image, and security cases |
| src/lib/__tests__/wikiLinks.test.ts | Generated-link composition cases |
| src/lib/__tests__/pdf-images.test.ts | Lazy-to-eager PDF readiness regression |
| src/lib/__tests__/pdfExport.test.ts | PDF IDs, TOC, and image preservation |
| src/composables/vault/__tests__/useMarkdownRender.test.ts | Final page-nav IDs/labels |
| e2e/markdown-extensions-md-ext-1.spec.ts | Reader and prepared-PDF browser coverage |
| docs/design/vitepress-markdown-extensions-implementation-plan.md | Lifecycle/status/evidence handoff |
| docs/README.md | Design index link |
| docs/design/vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md | This evidence |

No package, lockfile, server, resource, Shiki runtime, or dependency file changed.

## 8. Validation evidence

### Focused unit tests

Command:

    ./node_modules/.bin/vitest run src/lib/__tests__/markdown.test.ts src/lib/__tests__/wikiLinks.test.ts src/composables/vault/__tests__/useMarkdownRender.test.ts src/lib/__tests__/shiki.test.ts src/lib/__tests__/callouts.test.ts src/lib/__tests__/math.test.ts src/lib/__tests__/markmapSecurity.test.ts src/components/__tests__/MarkMap.test.ts src/components/MarkMapSecurity.test.ts src/components/__tests__/Mermaid.test.ts src/lib/__tests__/pdfExport.test.ts src/lib/__tests__/pdf-images.test.ts src/lib/__tests__/pdf-readiness.test.ts src/components/vault/__tests__/PdfExportSurface.test.ts

Result: PASS — 14 files, 229 tests. The focused set covers existing Shiki,
Mermaid, MarkMap, math, sanitizer, WikiLink, PDF, and render-lifecycle contracts in
addition to MD-EXT-1.

### Typecheck and build

    npm run typecheck → PASS
    npm run build     → PASS

The build transformed 3,931 modules. Existing Rolldown INVALID_ANNOTATION warnings
from @vueuse/core and existing greater-than-500-kB chunk warnings remain; no warning
was converted into a failure or hidden.

### Browser and PDF tests

    npm run test:e2e -- e2e/markdown-extensions-md-ext-1.spec.ts \
      e2e/markdown-shiki-security.spec.ts e2e/markdown-shiki-theme.spec.ts \
      e2e/markdown-visual.spec.ts e2e/pdf-export-shiki.spec.ts

Result: PASS — 7 tests.

    npm run test:e2e -- e2e/pdf-export.spec.ts

Result: PASS — 2 tests, including Kitchen Sink export and the delayed same-origin
image readiness case. The latter initially exposed the lazy-image readiness issue
documented in section 6 and passed after the minimal correction.

### Full unit suite

    npm run test:unit → FAIL

Result: 208 test files passed, 3 failed; 3,108 tests passed, 21 failed, 2 skipped.
The failures are outside the Markdown extension surface:

- all 19 server/__tests__/openai-http.test.ts cases fail at loopback listen with
  listen EPERM: operation not permitted 127.0.0.1;
- one Round-15 crash-child case and one Round-16 crash-child case fail because tsx
  cannot create its IPC pipe, also with listen EPERM.

This is recorded as a baseline/environment limitation, not as PASS. No Markdown,
Shiki, client, TOC, link, image, or PDF unit failure appeared. Compared with the
MD-EXT-0 full-unit evidence (4 files/22 failures), the current run has no new
product-surface failure and one fewer environment failure.

## 9. Bundle comparison

The post-MD-EXT-1 production build contains 473 asset files and 404 JavaScript
assets. Representative current assets are:

| Asset | Raw bytes | Gzip bytes | Role |
| --- | ---: | ---: | --- |
| EditorPane-D8rnZgco.js | 3,648,931 | 921,510 | editor surface |
| VaultView-DFSfTC76.js | 1,871,469 | 528,596 | reader/vault surface |
| index-Dm2Td5KA.js | 231,721 | 77,311 | application entry |
| index-52ljFfOT.css | 134,504 | 27,194 | main CSS |

The MD-EXT-0 baseline was 467 asset files / 404 JavaScript assets, with 133,950-byte
main CSS and the same lazy Shiki grammar/theme strategy. The small expected growth is
localized to the Markdown/TOC/CSS/PDF integration; Shiki remains split into lazy
language/theme chunks and no second parser or highlighter was introduced.

## 10. Reader, security, and PDF acceptance

- Automatic and custom anchors expose the same final IDs to permalinks, page-nav,
  TOC, and PDF.
- [[toc]] is static, nested, escaped, and limited to h2-h4.
- Generated HTTP(S) links receive the approved target/rel policy; raw HTML links do
  not receive a new policy. The stable generated-link class cannot grant sanitizer
  privilege, and no temporary provenance marker survives.
- Escaped/entity-produced `{#id}` text remains literal and uses the automatic ID path.
- Markdown images are lazy; raw HTML images are not rewritten.
- The sanitizer still forbids style, strips event handlers and dangerous URIs, and
  does not become a generic attribute passthrough.
- Reader light/dark rendering is theme-neutral for IDs, TOC, links, and lazy images.
- PDF retains final fragment targets and static TOC content, and its existing
  printable-light/widget/pagination behavior remains green.
- PDF image readiness explicitly settles lazy Markdown images without rereading their
  resources.

## 11. Rollback and phase boundary

Reverting the MD-EXT-1 implementation and its tests/evidence restores the previous
automatic-anchor, page-nav, link, image, and PDF-surface behavior without touching
Shiki, containers, fence metadata, line numbers, code groups, or resources.

MD-EXT-2 — Custom Containers is NOT STARTED. No MD-EXT-2 code or dependency work
is included in this phase.

## 12. Exit criteria

- [x] One per-render final ID allocator with uniqueSlugStartIndex: 2.
- [x] Custom anchors, collisions, permalinks, page-nav, TOC, and PDF IDs agree.
- [x] Standalone [[toc]] supports final h2-h4 IDs without a second resolver/parser.
- [x] Generated external HTTP(S) policy is limited to Markdown/linkify output.
- [x] External-link trust uses an opaque per-render marker rather than a forgeable class.
- [x] Source-aware custom-anchor recognition keeps escaped/entity-produced literals visible.
- [x] Raw HTML anchors and images retain existing behavior.
- [x] Markdown images are lazy and PDF readiness remains settled.
- [x] DOMPurify security invariants remain intact.
- [x] Focused unit, typecheck, build, browser, and PDF evidence recorded honestly.
- [x] Full-unit environment limitations recorded as FAIL, not hidden.
- [x] MD-EXT-2 remains not started.

Next phase, only after review: MD-EXT-2 — Custom Containers.

## 13. Review follow-up evidence

The corrective follow-up was applied on top of implementation commit
98547cf8d2a78207ea8060199081ddcbe450bf5c. It closes two review findings without
changing MD-EXT-1 product scope:

- `nuvyn-external-link` remains a stable presentation/classification class, but is
  no longer used as sanitizer trust. Each `render()` creates a secure-random,
  render-scoped provenance token. Only a generated Markdown/linkify anchor carrying
  the matching temporary marker can retain `target="_blank"`; the marker is removed
  before the sanitized HTML is returned. Raw HTML class/marker forgeries do not gain
  the generated-link privilege, and concurrent render contexts remain isolated.
- Custom-anchor authorization now checks the original `inline.content` source. A
  real final `{#id}` works; escaped `\{#id}` and entity-produced `&#123;#id}` remain
  visible literal text and use automatic IDs. Even/odd backslash behavior follows
  Markdown escape semantics, and only the final approved suffix is metadata.

Follow-up validation:

    ./node_modules/.bin/vitest run src/lib/__tests__/markdown.test.ts src/lib/__tests__/wikiLinks.test.ts src/composables/vault/__tests__/useMarkdownRender.test.ts src/lib/__tests__/shiki.test.ts src/lib/__tests__/pdfExport.test.ts src/lib/__tests__/pdf-images.test.ts src/lib/__tests__/pdf-readiness.test.ts src/lib/__tests__/markmapSecurity.test.ts src/lib/__tests__/callouts.test.ts src/lib/__tests__/math.test.ts src/components/__tests__/MarkMap.test.ts src/components/MarkMapSecurity.test.ts src/components/__tests__/Mermaid.test.ts src/components/vault/__tests__/PdfExportSurface.test.ts

Result: PASS — 13 files, 231 tests. This includes the raw HTML forged-class and
guessed-marker cases, render/sanitizer isolation, source-aware escaped/entity
headings, backslash edges, automatic-ID TOC reuse, and the existing PDF/readiness
contracts.

    npm run typecheck → PASS
    npm run build     → PASS — 3,931 modules transformed

Focused browser/PDF validation also passed:

    MD-EXT-1 + Shiki security/theme/visual + PDF Shiki matrix → 7 passed
    e2e/pdf-export.spec.ts                                    → 2 passed

The full unit suite remains baseline-limited, not green:

    npm run test:unit → FAIL — 208 files passed, 3 failed;
    3,111 tests passed, 21 failed, 2 skipped.

The 21 failures are the same pre-existing environment class: 19
`server/__tests__/openai-http.test.ts` loopback `listen EPERM` failures and one
`tsx` IPC `listen EPERM` failure in each of the Round-15 and Round-16 crash-child
tests. No Markdown, client, security, Shiki, TOC, link, image, or PDF product
regression appeared.

The follow-up keeps FORBID_ATTR: ['style'], generic data-attribute restrictions,
the single anchor allocator (`uniqueSlugStartIndex: 2`), final-ID TOC/page-nav/PDF
reuse, and all MD-EXT-2 boundaries unchanged. The follow-up completion SHA is
recorded in the final handoff after commit creation rather than self-referenced here.
