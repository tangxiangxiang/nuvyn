# Nuvyn VitePress-Style Markdown Extensions
# MD-EXT-2 — Custom Containers

## 1. Evidence metadata

| Field | Value |
| --- | --- |
| Phase | MD-EXT-2 — Custom Containers |
| Status | COMPLETE / REVIEW-CLOSED |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Previous phase review closure | 4c86783fc847fda43a5eaba95e1d32621d79b835 |
| MD-EXT-2 base | 4c86783fc847fda43a5eaba95e1d32621d79b835 |
| Approved PRD | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Approved Implementation Plan | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Original MD-EXT-2 implementation | 5bc39e84b9e859b23275a8b02302348b10616a55 |
| MD-EXT-2 completion commit | Recorded in the final handoff after this evidence commit is created |
| Opaque-block review follow-up | Recorded in the final handoff after this follow-up commit is created |
| Paragraph-context follow-up | Recorded in the final handoff after this follow-up commit is created |
| Next phase | MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata — NOT STARTED |
| Shiki prerequisite | H0-H8 COMPLETE / CLOSED; no H9 |

The original MD-EXT-2 implementation started from a clean `main` checkout at `4c86783fc847fda43a5eaba95e1d32621d79b835`. The opaque-block review follow-up is applied on top of `5bc39e84b9e859b23275a8b02302348b10616a55`, and this paragraph-context follow-up is applied on top of `5ba5798b74e7dfe5ae7316993ee62beecf26d814`; the earlier commits are not being rewritten to claim they contained these corrections. No dependency, server, resource, Shiki-runtime, math, or MD-EXT-1 architecture changes were made.

## 2. Scope and changed files

MD-EXT-2 implements only the five fixed Nuvyn container types, safe titles, nested block parsing, literal `details {open}`, existing callout coexistence, reader styling, PDF clone expansion, and focused regression evidence.

Changed files:

| File | Purpose |
| --- | --- |
| `src/lib/markdownContainers.ts` | Nuvyn-owned block rule, fixed type allowlist, title tokens, delimiter matching, nested body tokenization |
| `src/lib/markdown.ts` | Registers the container rule and adds the single `open` sanitizer attribute |
| `src/style.css` | Reader container palette and native details styling |
| `src/lib/pdfExport.ts` | Printable-light container styles and clone-only generated-details expansion |
| `src/lib/__tests__/markdownContainers.test.ts` | Container grammar, nesting, compatibility, security, and Shiki-preparation tests |
| `src/lib/__tests__/pdfExport.test.ts` | PDF clone expansion and reader-state isolation regression |
| `e2e/markdown-extensions-md-ext-2.spec.ts` | Reader and prepared-PDF browser coverage |
| `docs/README.md` | MD-EXT-2 evidence index link |
| `docs/design/vitepress-markdown-extensions-implementation-plan.md` | Lifecycle/status, current parser flow, file ownership, and evidence handoff |
| `docs/design/vitepress-markdown-extensions-md-ext-2-containers.md` | This evidence document |

Forbidden-scope review:

```text
package.json / package-lock.json: unchanged
server/: unchanged
shared/: unchanged
src/lib/shiki.ts / src/shiki.css: unchanged
src/lib/wikiLinks.ts / src/lib/markdownHeadings.ts: unchanged
MD-EXT-3 annotation work: not started
MD-EXT-4 line-number work: not started
MD-EXT-5 code-group work: not started
MD-EXT-6 resource/include work: not started
```

## 3. Parser architecture

The implementation is a Nuvyn-owned MarkdownIt block rule named `nuvyn-container`, registered with:

```ts
md.block.ruler.before(
  'paragraph',
  'nuvyn-container',
  nuvynContainerRule,
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
)
```

The audited runtime block order now includes:

```text
table, code, nuvyn_math_block, fence, blockquote, hr, list,
footnote_def, reference, html_block, heading, lheading, deflist,
nuvyn-container, paragraph, inline
```

The named insertion point is stable and does not depend on numeric ruler indexes. The implementation does not preprocess the whole document, post-process HTML, invoke a second Markdown parser, or use module-global nesting state.

The follow-ups explicitly classify the earlier source-owning rules relevant to
close discovery and preserve the distinction between source syntax and actual
ownership at the current parser position:

| Rule | Classification | Scanner behavior |
| --- | --- | --- |
| `code` | opaque indented-code range only at a block boundary | skip the complete range using MarkdownIt's indentation/blank-line ownership; a >3-space line after an open paragraph remains lazy continuation |
| `nuvyn_math_block` | opaque Nuvyn math range only at a block boundary | skip a recognized `$$ ... $$` block, including delimiter-looking source lines; it does not gain paragraph-terminator behavior |
| `fence` | opaque fenced-code range | retain backtick/tilde fence matching and skip through its close |
| `html_block` | opaque raw-HTML range when MarkdownIt owns it | types 1–6 may interrupt a paragraph; type 7 cannot, but may own a range at a block boundary |

The close scanner does not probe by rendering, call `md.parse()` on substrings, or
create another MarkdownIt instance. It uses narrow source-range detectors aligned
with the installed MarkdownIt 14.2.0 rules and the existing Nuvyn math rule. It
tracks only `BLOCK BOUNDARY` versus `PARAGRAPH CONTINUATION`, probes the actual
`state.md.block.ruler.getRules('paragraph')` chain in silent mode with the Nuvyn
container rule excluded to avoid recursion, temporarily mirrors
`state.parentType = 'paragraph'`, and restores that state with `try/finally`.
Opaque ranges are skipped only after the probe establishes a real block boundary.
The mirrored HTML sequence metadata retains MarkdownIt's
`canTerminateParagraph` field; the installed `html_block` silent result remains
authoritative and the local metadata guards the final ownership decision.

The flow is:

```text
Markdown source
    ↓
MarkdownIt block rule
    ↓
normalized fixed container tokens
    ↓
same state.md.block.tokenize() for the body
    ↓
existing headings, callouts, math, links, fences, Mermaid, MarkMap
    ↓
existing renderer / Shiki / DOMPurify boundary
```

## 4. Grammar and normalized token contract

Recognized canonical types are exactly:

```text
info
tip
warning
danger
details
```

The parser accepts three or more consecutive `:` characters, an exact lower-case allowlisted type separated from the delimiter by whitespace, and an optional title remainder. Source type text is never interpolated into a class. The renderer receives only a validated enum and emits fixed classes:

```text
markdown-container markdown-container-info
markdown-container markdown-container-tip
markdown-container markdown-container-warning
markdown-container markdown-container-danger
markdown-container markdown-container-details
```

Normal containers render as fixed `<div>` structures. `details` renders native semantic HTML:

```html
<details class="markdown-container markdown-container-details">
  <summary class="markdown-container-title">...</summary>
  ...
</details>
```

The title is a separate inline token, not an HTML attribute string. This preserves ordinary safe inline Markdown and sends title HTML through the same final DOMPurify boundary.

Default titles are the existing Nuvyn-style capitalized names:

```text
Info / Tip / Warning / Danger / Details
```

Custom titles retain the complete title remainder, for example `::: danger STOP` and `::: tip **Custom** Tip`. No localization or generic attribute syntax was added.

The normalized parser metadata contains only:

```ts
{
  type: 'info' | 'tip' | 'warning' | 'danger' | 'details',
  markerLength: number,
  open: boolean,
  title: string,
}
```

## 5. Delimiters, nesting, and malformed input

A closing delimiter is a colon run of at least three characters followed only by horizontal whitespace. It belongs to the current opener only when its marker length is at least the opener length.

Nested containers are recognized when the nested opener is shorter than the outer opener. The scanner recursively skips a matched shorter nested container before looking for the outer close. This gives deterministic ownership for:

```markdown
::::: info Outer
:::: warning Middle
::: details Inner
Body
:::
::::
:::::
```

Same-type nesting uses the same delimiter rule; container type is never used to decide which close belongs to which opener.

Fenced code ranges are skipped while looking for container delimiters. Therefore `:::` and longer colon runs inside a code fence remain literal code source. This prevents a code example from closing or opening a surrounding container accidentally.

### Opaque earlier-block ownership follow-up

The original implementation's source scan was extended after review so raw HTML and
the other earlier opaque block rules retain ownership of their complete source
ranges. In particular:

```markdown
:::: info HTML example

<div>
::::
</div>

After HTML

::::
```

keeps the inner `::::` inside the raw HTML block and keeps `After HTML` inside the
outer container. The same boundary is covered for nested-container-looking lines
inside a raw `<section>`, delimiter-looking math source, indented code, and both
backtick and tilde fenced code. Raw HTML remains enabled and still passes through
the existing DOMPurify boundary; this is parser ownership protection, not a
sanitizer relaxation.

### Paragraph-context ownership follow-up

The final scanner does not equate an opaque-looking line with an owned opaque
block. The structural close for the current container is checked first, and a
valid shorter nested opener keeps its existing recursive delimiter ownership.
For other lines, an open paragraph is tracked as follows:

```text
empty line                         → block boundary
indentation > 3 / negative indent → paragraph continuation
silent paragraph terminator       → block boundary, then re-evaluate line
no terminator                      → paragraph continuation
```

This produces the required paired HTML behavior:

- `<span>inline</span>` (HTML type 7) after `Before` remains in the paragraph, so
  the following `::::` closes the outer container;
- `<span>` at a true block boundary owns its HTML range, so delimiter-looking
  lines through the blank-line close remain HTML source;
- `<div>` (HTML type 1–6) can interrupt a paragraph where the installed
  `html_block` rule says it can, so its inner delimiter remains protected.

Nuvyn `$$` math is not in the paragraph terminator alt chain, and indented code
does not interrupt an existing paragraph. Both therefore remain ordinary
paragraph continuation in those contexts while retaining opaque protection at a
real block boundary. Backtick and tilde fences remain paragraph terminators and
retain their previous protection. Silent probes are performed on the existing
state only; no tokens, renderer, resolver, sanitizer, Shiki runtime, or second
MarkdownIt parser is invoked.

An unclosed opaque block follows the same safe fallback semantics as MarkdownIt:
the scanner does not invent a close or swallow unrelated content. No module-global
opaque-range state is introduced, and normal nested-container delimiter ownership
is unchanged.

If a supported opener has no owned close, the rule returns `false` and MarkdownIt falls back to ordinary Markdown parsing. The implementation does not consume the unrelated document tail. Unknown types, including `success`, `note`, `custom`, and `code-group`, are not mapped to a Nuvyn container or arbitrary class. `::: code-group` remains outside MD-EXT-2.

## 6. Details `{open}` contract

Only the exact literal `{open}` token at the end of a `details` title metadata position is consumed:

```markdown
::: details Open example {open}
Visible initially.
:::
```

This produces a generated boolean `open` attribute. The following are not generic attributes and do not open a details container:

```text
{OPEN}
{ open }
{open=true}
{open=false}
{open} Title
```

`info`, `tip`, `warning`, and `danger` never consume `{open}`. No `id`, `class`, `style`, `onclick`, or other braces grammar exists.

## 7. Body and existing feature compatibility

Container body lines are tokenized by the same MarkdownIt block parser and render environment. The focused tests prove:

- headings and custom anchors inside a container use the MD-EXT-1 final allocator;
- `[[toc]]` reuses the final nested heading ID;
- generated external Markdown links retain `target="_blank"` and `rel="noopener noreferrer"`;
- Markdown images retain `loading="lazy"`;
- existing `> [!NOTE]` callouts render inside a container;
- a custom container renders inside a callout where normal blockquote prefix rules permit it;
- Shiki fences inside a container use the existing one-runtime preparation/render path;
- exact `mermaid` and `markmap` fences remain placeholders and do not enter Shiki;
- math placeholders remain owned by the existing math mount lifecycle;
- ordinary blockquotes remain ordinary when they do not match the existing callout marker.

The existing `src/lib/callouts.ts` plugin was not rewritten or replaced. Callout classes, aliases, titles, and core transformation remain authoritative.

## 8. Reader styling and state

Reader styles are scoped under `.article .markdown-container` and use Nuvyn/VS Code theme variables. The type colors are fixed CSS declarations for the five allowlisted types; no Markdown value becomes a selector or inline style.

`details` is native browser disclosure state. Closed details are closed by default; literal `{open}` details start open; a real Chromium `summary.click()` regression confirms native disclosure toggles closed → open → closed without custom JavaScript. Theme switching remains CSS-only and does not rerender Markdown or retokenize Shiki.

## 9. Sanitizer and security delta

The final DOMPurify boundary remains in `src/lib/markdown.ts` with:

```text
FORBID_ATTR: ['style']
```

unchanged. The only MD-EXT-2 allowlist delta is:

```text
ALLOWED_ATTR += open
```

`open` is used by the parser only for the exact generated `details {open}` feature. Raw HTML details behavior continues under the existing sanitizer contract; no generic attribute bridge was introduced.

The security tests cover:

```text
generic {#id}, {.class}, {style=...}, {onclick=...}: no generated attrs/classes
unknown type: no arbitrary markdown-container-<source> class
dangerous title HTML: script/event/style removed by DOMPurify
FORBID_ATTR ['style']: unchanged
event handlers: removed
unknown data-* attributes: existing policy retained
```

Container types are normalized against an enum before rendering. Titles are inline tokens, not trusted HTML. No parser-side sanitizer bypass, Vue directive execution, inline CSS, event handler, or generated source-derived CSS was added.

## 10. PDF behavior

`preparePdfArticleHtml()` clones the already-rendered article. Before widget staticization, it sets `open = true` only on:

```css
details.markdown-container-details
```

The live reader is not mutated, Markdown is not rerendered, and resources are not reread. Unrelated raw HTML `<details>` elements are not automatically expanded.

The PDF stylesheet adds printable-light rules for the container surface, fixed title, border, and type distinction. It deliberately does not apply a blanket descendant `color` rule, so nested Shiki token spans retain their printable-light token colors.

The PDF helper regression proves:

```text
closed generated details → open in prepared clone
reader details → remains closed
raw author details → remains unchanged
body/title/nesting → retained
```

Existing PDF layout, wrapping, oversized-block splitting, Mermaid/MarkMap/math staticization, image readiness, and pagination paths remain in place. The focused PDF compatibility/layout/pagination/stress browser set passed after the container styles and clone change.

## 11. Validation evidence

### Focused unit

```text
./node_modules/.bin/vitest run \
  src/lib/__tests__/markdownContainers.test.ts \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/callouts.test.ts \
  src/lib/__tests__/wikiLinks.test.ts \
  src/lib/__tests__/shiki.test.ts \
  src/composables/vault/__tests__/useMarkdownRender.test.ts \
  src/lib/__tests__/pdfExport.test.ts \
  src/lib/__tests__/pdf-images.test.ts \
  src/lib/__tests__/pdf-readiness.test.ts
```

Result:

```text
Original implementation baseline: PASS — 9 test files, 190 tests
Follow-up rerun: PASS — 9 test files, 197 tests
```

The container/PDF subset alone also passed 2 files / 27 tests.

The opaque-block follow-up focused unit run passed all 17
`markdownContainers.test.ts` tests, including raw HTML, math, indented-code, and
fenced-code ownership cases.

### Typecheck and build

```text
npm run typecheck → PASS
npm run build     → PASS — 3,932 modules transformed
```

Build warnings are the existing Rolldown `INVALID_ANNOTATION` warnings from `@vueuse/core` and existing >500 kB chunk warnings. No warning was hidden or converted into a pass.

### Focused browser/PDF

```text
npm run test:e2e -- \
  e2e/markdown-extensions-md-ext-2.spec.ts \
  e2e/markdown-extensions-md-ext-1.spec.ts \
  e2e/markdown-shiki-security.spec.ts \
  e2e/markdown-shiki-theme.spec.ts \
  e2e/markdown-visual.spec.ts \
  e2e/pdf-export-shiki.spec.ts \
  e2e/pdf-export.spec.ts

PASS — 11 tests
```

The follow-up's native disclosure browser regression also passed: Chromium located
the generated `<summary>`, clicked it with Playwright, observed `details.open ===
true`, then clicked again and observed `false`.

The follow-up focused browser command covering the MD-EXT-2, MD-EXT-1, Shiki
security, Markdown visual, and PDF Shiki specs passed 9 tests. The original
implementation's broader Markdown/PDF command remains recorded above as the
historical 11-test result.

The existing PDF compatibility/layout/pagination/stress set also passed:

```text
e2e/pdf-export-compat.spec.ts
e2e/pdf-export-layout.spec.ts
e2e/pdf-export-pagination.spec.ts
e2e/pdf-export-stress.spec.ts
PASS — 10 tests
```

The first browser attempt was blocked by the sandbox's loopback bind permission on `127.0.0.1:4174`; the same command passed with the controlled local web-server permission. This is an environment limitation, not a product test result.

### Full unit suite

```text
npm run test:unit → FAIL, exit code 1
Test Files: 3 failed | 209 passed (212)
Tests: 21 failed | 3123 passed | 2 skipped (3146)
```

All 21 failures are the existing environment/shared-fixture class:

- 19 `server/__tests__/openai-http.test.ts` tests cannot bind loopback `127.0.0.1` (`listen EPERM`);
- one Round-15 crash-child test cannot create the `tsx` IPC pipe (`listen EPERM`);
- one Round-16 crash-child test has the same `tsx` IPC restriction.

No Markdown, container, callout, Shiki, client, or PDF product regression failed in the full run. The command remains honestly recorded as FAIL rather than relabeled PASS.

### Paragraph-context follow-up rerun

The final parser-context correction added five integration regressions covering
HTML type 7 in an open paragraph and at a block boundary, HTML types 1–6,
paragraph-continuation math-looking `$$`, and lazy indented continuation. The
focused rerun passed:

```text
markdownContainers.test.ts → PASS — 22 tests
focused unit command       → PASS — 9 test files, 202 tests
npm run typecheck           → PASS
npm run build               → PASS — 3,932 modules transformed
```

The full unit rerun remained limited to the same environment failures, with no
new product regression:

```text
npm run test:unit → FAIL, exit code 1
Test Files: 3 failed | 209 passed (212)
Tests: 21 failed | 3134 passed | 2 skipped (3157)
```

The focused browser rerun passed 8 tests across MD-EXT-1, MD-EXT-2, Shiki
security, and Markdown visual coverage. The MD-EXT-2 file passed all 3 tests,
including the new Chromium-visible type-7 paragraph-context assertion. The
focused PDF rerun passed 3 tests (`pdf-export-shiki.spec.ts` and
`pdf-export.spec.ts`).

### Earlier opaque-block follow-up historical result

The earlier opaque-block-only rerun, before this parser-context correction, remained
limited to the same environment failures:

```text
Test Files: 3 failed | 209 passed (212)
Tests: 21 failed | 3129 passed | 2 skipped (3152)
```

No new Markdown, container, math, Shiki, client, or PDF failure appeared.

## 12. Bundle comparison

The post-MD-EXT-2 production build contains 467 asset files. Representative current assets reported by Vite are:

| Asset | Raw | Gzip | Role |
| --- | ---: | ---: | --- |
| `EditorPane-Ov5sSKcW.js` | 3,648.93 kB | 932.79 kB | editor surface |
| `VaultView-BZFtitc8.js` | 1,877.15 kB | 536.55 kB | reader/vault surface |
| `index-DOcimJGG.js` | 231.72 kB | 77.96 kB | application entry |
| `index-Bxhq-4Zg.css` | 135.57 kB | 27.36 kB | main CSS |

The MD-EXT-1 evidence recorded 473 asset files, 404 JavaScript assets, 1,871.47 kB VaultView, and 134.50 kB main CSS; the current build remains within the same split/lazy Shiki architecture. The container feature adds no dependency, no second MarkdownIt, no second Shiki highlighter, and no eager grammar catalog. The expected CSS/reader-surface growth is localized to the new fixed container rules.

## 13. Architecture and rollback

Architecture proof:

```text
MarkdownIt instances: one main singleton
Container parser: Nuvyn-owned block rule
Container module-global mutable state: none
Shiki highlighters: existing one
New syntax-highlighting path: none
Existing calloutPlugin: preserved
Heading/TOC allocator: preserved
PDF rerender: no
PDF resource reread: no
```

Reverting MD-EXT-2 removes only the container parser/registration, fixed reader/PDF styles, clone expansion, associated tests, evidence, and index/lifecycle links. MD-EXT-1 anchors/TOC/external-link provenance/lazy images, H8 Shiki, callouts, math, Mermaid, MarkMap, and the existing PDF baseline remain independently owned.

## 14. Exit criteria

```text
info / tip / warning / danger / details: PASS
default and custom titles: PASS
nested and same-type containers: PASS
fence-length close ownership: PASS
code-fence delimiter lookalikes: PASS
unclosed/unknown syntax: safe fallback
native details closed/open behavior: PASS
generic attrs: absent
sanitizer delta: open only
FORBID_ATTR ['style']: unchanged
existing callouts: preserved and coexist
headings/anchors/TOC/WikiLinks/links/images: PASS
Shiki/Mermaid/MarkMap/math: PASS
reader theme behavior: CSS-only and readable
PDF generated details always expanded: PASS
PDF reader-state isolation: PASS
focused unit/typecheck/build/browser/PDF: PASS
full unit: no new product regression; environment-limited FAIL recorded
dependencies/server/resources: unchanged
MD-EXT-3: NOT STARTED
```

## 15. Final handoff

```text
MD-EXT-2: COMPLETE / REVIEW-CLOSED
Implementation: COMPLETE
Original implementation: 5bc39e84b9e859b23275a8b02302348b10616a55
Opaque-block review follow-up: applied; final SHA recorded in handoff
MD-EXT-3: READY / NOT STARTED
Shiki H0-H8: COMPLETE / CLOSED
No H9 created
```

Only after review approval should work begin on:

```text
MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata
```
