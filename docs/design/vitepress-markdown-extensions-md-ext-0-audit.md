# Nuvyn VitePress-Style Markdown Extensions — MD-EXT-0 Baseline & Compatibility Contract Audit

## 1. Audit metadata

| Field | Value |
| --- | --- |
| Audit status | MD-EXT-0 — COMPLETE |
| Program | Nuvyn VitePress-Style Markdown Extensions |
| Repository | tangxiangxiang/nuvyn |
| Branch | main |
| Audit date | 2026-08-22 |
| Audit HEAD | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| MD-EXT-0 base | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Product production baseline | c32f5bc9c1597c6c2f6b3e9581f327636fe8d8c2 |
| Approved PRD baseline | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Implementation Plan baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| H0-H8 Shiki prerequisite | COMPLETE / CLOSED; no H9 |
| Production implementation | Not started |
| MD-EXT-1 | Not started |
| Evidence commit | The commit containing this evidence document; exact SHA is reported in the final handoff and is intentionally not self-referenced here |

This audit was collected at the implementation baseline itself. The audit HEAD and
MD-EXT-0 base are therefore identical. The later evidence commit will contain only
the audit document, the lifecycle/index links, and no application behavior change.

The authoritative inputs were read before the audit:

- docs/design/vitepress-markdown-extensions-prd.md
- docs/design/vitepress-markdown-extensions-implementation-plan.md
- docs/design/syntax-highlighting-shiki-migration-prd.md
- docs/design/syntax-highlighting-shiki-migration-implementation-plan.md
- docs/design/syntax-highlighting-shiki-h8-release-gate.md

The PRD is the product authority. This document records the verified implementation
parameters for later phases; it does not silently revise the PRD or implement any
extension.

## 2. Audit scope and verdict rule

MD-EXT-0 was an evidence-only phase. It inspected the current implementation,
installed packages, test contracts, browser/PDF behavior, and future ownership
boundaries. It did not install packages, change production source, modify tests,
change the sanitizer, add a route, or alter the Markdown renderer.

The audit is COMPLETE because:

- every implementation-critical parameter required by MD-EXT-1 through MD-EXT-6 is
  selected and recorded below;
- the current implementation has no product-semantic contradiction with the
  approved PRD;
- all focused Markdown/Shiki/MarkMap/Math/PDF/server baseline tests passed;
- typecheck, build, focused browser tests, and the broader Markdown/PDF browser set
  passed;
- the full unit command has 22 unrelated environment/shared-fixture failures, which
  are recorded with their actual exit code and error signatures in section 30;
- no MD-EXT-related test, typecheck, build, or browser regression was found.

The full unit command is not relabeled as PASS. Its result remains FAIL in the
historical evidence table.

## 3. Repository and environment baseline

### 3.1 Git state

Commands and results at audit start:

~~~text
git status --short
<empty>

git rev-parse HEAD
582e312a4c5752a4c9a5c6bba7b0e752b0b78078

git log -8 --oneline
582e312 docs(markdown): clarify implementation plan contracts
003fbe4 docs(markdown): add extensions implementation plan
7e05e3b docs(markdown): clarify extensions prd contracts
45de8e3 docs(markdown): define vitepress-style extensions prd
c32f5bc chore(shiki): complete migration release gate
d584abf chore(shiki): remove nuvyn highlightjs dependency
6caa4f0 feat(shiki): add printable PDF highlighting
9d5d8a9 feat(shiki): integrate reader themes
~~~

The immutable implementation baseline is 582e312. It is not replaced by the
eventual evidence commit. The production baseline remains c32f5bc; the approved PRD
baseline remains 7e05e3b.

### 3.2 Runtime environment

| Item | Observed value |
| --- | --- |
| OS | Darwin 25.5.0 arm64 |
| Node used for audit | v24.15.0 |
| npm used for audit | 11.12.1 |
| Docker runtime baseline | node:22-bookworm-slim in Dockerfile |
| Package manager | npm |
| Lockfile | package-lock.json |
| pnpm/yarn/bun lockfiles | absent |
| Existing node_modules | present; used for read-only audit commands |
| npm ci | not run; no dependency mutation was required |

The local Node 24 audit environment is not the same as the Docker Node 22 runtime.
That distinction is retained in the evidence and is not treated as a product
failure.

## 4. Dependency inventory

The dependency files were read but not changed. Declared ranges and resolved
top-level versions are:

| Package | package.json | package-lock / installed | MD-EXT-0 decision |
| --- | --- | --- | --- |
| markdown-it | ^14.1.0 | 14.2.0 | Keep the existing MarkdownIt 14.x singleton |
| markdown-it-anchor | ^9.2.0 | 9.2.0 | Reuse; configure the approved suffix allocator in MD-EXT-1 |
| shiki | ^4.4.3 | 4.4.3 | Reuse the H8 singleton |
| @shikijs/transformers | ^4.4.3 | 4.4.3 | Reuse approved transformers |
| dompurify | ^3.4.10 | 3.4.10 | Keep the final sanitizer boundary |
| vue | ^3.5.34 | 3.5.35 | Existing surface |
| vite | ^8.0.12 | 8.0.16 | Existing build |
| typescript | ~6.0.2 | 6.0.3 | Existing typecheck |
| vitest | ^4.1.8 | 4.1.8 | Existing unit tests |
| @playwright/test | ^1.61.1 | 1.61.1 | Existing browser tests |
| html2pdf.js | ^0.14.0 | 0.14.0 | Existing PDF path |
| markmap-lib / markmap-view | ^0.18.12 | 0.18.12 | Existing MarkMap path |
| mermaid | ^11.15.0 | 11.15.0 | Existing Mermaid path |

The following are not installed and are not approved as dependencies for this
program:

~~~text
vitepress
@vitepress/*
markdown-it-attrs
markdown-it-container
MDX packages
~~~

The installed markdown-it is 14.2.0 while the plan's original wording used the
14.1.x API baseline. This is within the declared ^14.1.0 range and the audited
rule/API behavior is compatible; the resolved version is recorded rather than
silently rounded down.

## 5. Markdown rendering call flow

### 5.1 Main document surface

The verified current flow is:

~~~text
raw Markdown
    ↓
useMarkdownRender.ts parseDoc()
    ↓
useMarkdownRender.ts async render()
    ↓
src/lib/markdown.ts render(markdown, options)
    ↓
getMd() resolves the one main MarkdownIt singleton
    ↓
md.parse(markdown, isolated discovery env)
    ↓
collect fence tokens and prepare Shiki languages
    ↓
fresh real WikiLinkEnv with the caller resolver
    ↓
md.render(markdown, real render env)
    ↓
fence callback:
  exact mermaid/markmap placeholder
  normal Shiki HTML
  escaped plain-code fallback
    ↓
DOMPurify.sanitize()
    ↓
RenderedMarkdown.vue v-html
    ↓
MarkMap / Mermaid / Math post-render mounts
    ↓
ReadingPane page-nav and scroll-spy consumers
~~~

The relevant stage contract is:

| Stage | File | Function/API | Async? | User-controlled input |
| --- | --- | --- | --- | --- |
| Parse document wrapper | src/composables/vault/useMarkdownRender.ts | parseDoc | synchronous | frontmatter and body |
| Render lifecycle | src/composables/vault/useMarkdownRender.ts | render | yes | Markdown and render options |
| MarkdownIt access | src/lib/markdown.ts | getMd | async singleton creation | plugin configuration, not raw user data |
| Discovery preflight | src/lib/markdown.ts | md.parse with isolated env | synchronous | raw Markdown; resolver absent |
| Language preparation | src/lib/shiki.ts | prepareShikiLanguages | yes | fence language identifiers |
| Final Markdown render | src/lib/markdown.ts | md.render with fresh env | synchronous after preparation | Markdown, including HTML |
| Fence rendering | src/lib/markdown.ts / src/lib/shiki.ts | renderFence / highlightShikiFence | synchronous callback | fence info and code source |
| Sanitization | src/lib/markdown.ts | sanitizeMarkdownHtml | synchronous | complete generated HTML |
| DOM insertion | src/components/vault/RenderedMarkdown.vue | v-html | Vue update | sanitized HTML |
| Widget mounting | src/components/vault/RenderedMarkdown.vue and mount composables | MarkMap/Mermaid/Math mounts | post-render | placeholders and encoded data |

### 5.2 Singleton and separate AI surface

The main Nuvyn renderer owns one MarkdownIt singleton in src/lib/markdown.ts. The
current render contract is async because discovery and Shiki preparation happen
before the synchronous final render.

src/lib/aiMarkdown.ts creates a separate MarkdownIt instance for AI-message output.
It intentionally uses html: false and has its own tests. It is a separate output
surface, not a second main document renderer and not an MD-EXT target. MD-EXT work
must not accidentally merge the two surfaces or change AI-message semantics.

## 6. MarkdownIt singleton and rule inventory

The main MarkdownIt instance is configured with html: true, linkify: true, and
typographer: true. Current plugin installation order is:

~~~text
markdown-it core
task lists
markdown-it-anchor
footnote
deflist
mark
wikiLinkPlugin
calloutPlugin
mathPlugin
emoji
table renderer overrides
~~~

The runtime ruler names captured from the installed 14.2.0 instance are:

| Ruler | Current order |
| --- | --- |
| block | table, code, nuvyn_math_block, fence, blockquote, hr, list, footnote_def, reference, html_block, heading, lheading, deflist, paragraph, inline |
| inline | wiki_link, text, linkify, newline, nuvyn_math_inline, escape, backticks, strikethrough, emphasis, link, image, footnote_inline, footnote_ref, autolink, html_inline, entity |
| core | normalize, block, inline, nuvyn-callouts, footnote_tail, github-task-lists, linkify, emoji, replacements, smartquotes, text_join, anchor |

The exact names matter for future insertion points:

- logical heading metadata must be prepared before the existing anchor core rule;
- final TOC collection must consume the anchor-assigned IDs rather than create a
  second slugger;
- callouts remain the existing nuvyn-callouts core rule;
- math remains before normal fence/inline handling;
- WikiLinks remain the existing wiki_link inline rule and link_open ownership;
- resource expansion must finish before the final discovery parse.

The actual current rule order is evidence, not permission to replace the parser or
reorder unrelated existing features.

## 7. markdown-it-anchor 9.2.0 audit

The installed package is markdown-it-anchor 9.2.0. Its core rule name is anchor and
its API exposes slugifyWithState, permalink, callback, tabIndex, and
uniqueSlugStartIndex.

The installed default is:

~~~text
uniqueSlugStartIndex: 1
~~~

The current production configuration supplies slugify and permalink header-link
behavior but does not yet set the approved MD-EXT value. Current production output
for three automatic Hello headings is therefore:

~~~text
hello
hello-1
hello-2
~~~

The approved future contract is:

~~~ts
.use(anchor, {
  slugifyWithState: ...,
  uniqueSlugStartIndex: 2,
  permalink: ...
})
~~~

The value 2 is frozen unless the PRD is reviewed. MD-EXT-1 must use one per-render
allocator for automatic IDs, explicit {#safe-id} IDs, included headings,
auto/custom collisions, permalink hrefs, TOC entries, page-nav, and PDF internal
links. No module-global collision registry and no second slugger are permitted.

## 8. Heading-ID contract proof

An audit-only harness using the installed anchor API, a per-render env queue, and
uniqueSlugStartIndex: 2 produced the approved sequence:

| Input | Expected/proven IDs |
| --- | --- |
| three automatic Hello headings | hello, hello-2, hello-3 |
| auto Hello then Other {#hello} | hello, hello-2 |
| First {#hello} then automatic Hello | hello, hello-2 |
| First {#x} then Second {#x} | x, x-2 |
| Hello, Other {#hello}, Hello | hello, hello-2, hello-3 |

This proves the installed anchor package can support the approved shared allocator
without a second slugger or generic attributes, provided the future narrow heading
metadata rule records explicit IDs in the same render state before anchor allocation.
The harness did not modify production source.

The only accepted explicit anchor grammar is:

~~~text
# Heading {#safe-id}
~~~

Class/style/event/generic attribute syntax remains rejected:

~~~text
# Heading {.class}
# Heading {style="..."}
# Heading {onclick="..."}
~~~

MD-EXT-0 verification requirement for MD-EXT-1 is to inspect the installed anchor
rule name, slugifyWithState, permalink callback, duplicate allocation behavior, and
actual insertion order. Stop if the installed integration cannot provide one
per-render allocator with hello / hello-2 / hello-3 semantics without weakening
the narrow grammar.

## 9. TOC integration decision

There is no current [[toc]] implementation. Current page navigation is downstream
of the final rendered HTML: useMarkdownRender extracts h2-h4 headings, ReadingPane
uses existing IDs and IntersectionObserver, and RightRail renders the list. No
second slugger exists in the current page-nav path.

The selected MD-EXT-1 design is a token/core-based standalone, case-sensitive
[[toc]] rule:

- h2-h4 by default;
- consumes final anchor IDs after the one allocator assigns them;
- emits static safe navigation markup;
- does not reparse raw Markdown or invoke the WikiResolver;
- uses safe text content and generated hrefs only;
- requires only the reviewed sanitizer delta nav and aria-label;
- works in the reader and PDF clone with the same IDs.

TOC insertion must be coordinated with the anchor core rule and cannot invent IDs
independently.

## 10. WikiLink, internal-link, and external-link renderer decision

src/lib/wikiLinks.ts owns the current wiki_link inline rule and the standard
link_open renderer classification for Nuvyn internal .md links. It converts
internal targets to /vault/ links with Nuvyn data attributes and uses the per-render
resolver. Current resolver-backed internal links are not external links.

MD-EXT-1 must compose with this owner in one link_open chain:

~~~text
existing WikiLink/internal .md classification
    ↓
generated Markdown/linkify HTTP(S) external classification
    ↓
one final renderToken call
~~~

For Nuvyn-generated Markdown links and linkify output only:

~~~text
http: / https: external links
target="_blank"
rel="noopener noreferrer"
~~~

The generated values cannot be weakened by author metadata. mailto, tel, fragment,
relative paths, ./, ../, /vault/ routes, WikiLinks, and Nuvyn .md links do not use
this external-link policy.

Raw semantic HTML anchors are parsed as html_inline and are outside link_open. The
initial feature does not rewrite raw HTML <a> elements or silently change the
existing DOMPurify contract. A raw target="_self" therefore remains an existing
raw-HTML/security-policy concern, not an MD-EXT-1 generated-link rewrite.

This decision closes the opener-isolation and referrer-privacy choice as
noopener noreferrer. It does not add a second renderer owner.

## 11. Lazy-image decision

Current Markdown images use MarkdownIt's image path; raw HTML images remain
html_inline. The existing sanitizer already allows loading and applies the current
URI policy.

MD-EXT-1 adds loading="lazy" only to Markdown-generated image tokens. It does not
rewrite raw HTML images, change URI validation, or introduce a remote-resource
feature. Existing PDF image readiness and clone behavior remain the owner of export
settling.

## 12. DOMPurify and security baseline

The current sanitizer is created in src/lib/markdown.ts and is the final boundary
before article v-html. The verified configuration is:

~~~text
ALLOWED_TAGS:
a, abbr, b, blockquote, br, caption, code, col, colgroup, dd, del, details, div,
dl, dt, em, h1, h2, h3, h4, h5, h6, hr, i, img, input, kbd, label, li, mark, ol,
p, pre, q, s, samp, section, small, span, strong, sub, summary, sup, table, tbody,
td, tfoot, th, thead, tr, u, ul

ALLOWED_ATTR:
alt, aria-hidden, checked, class, colspan, data-anchor, data-content,
data-missing, data-target, disabled, height, href, id, loading, rel, role, rowspan,
src, target, title, type, width

ALLOW_DATA_ATTR: true
FORBID_ATTR: ['style']
FORBID_TAGS:
base, embed, form, iframe, link, math, meta, object, script, style, svg
~~~

A hook keeps only the Nuvyn data attributes data-anchor, data-content, data-missing,
and data-target. Event attributes are removed, and unrecognized data-* attributes
are removed. The URI policy permits the existing safe HTTP(S), mailto, tel,
fragment, root-relative, and relative forms while rejecting dangerous schemes.

The audit-only jsdom probes proved:

| Input | Observed sanitized result |
| --- | --- |
| span style="color:red" | style removed; span text remains |
| onclick | event attribute removed |
| img onerror | event attribute removed |
| javascript: href | unsafe href removed |
| details open | open absent under the current config |
| nav aria-label | nav absent under the current config |
| approved data-* | retained only for the four Nuvyn names |
| data-evil | removed |
| button | removed under the current config |
| ordinary role/id/aria-hidden div | retained where allowed |

The invariant FORBID_ATTR: ['style'] is not negotiable. Shiki generated CSS remains
trusted CSS outside article HTML; no extension may introduce style attributes,
event handlers, arbitrary tags, or a sanitizer bypass.

## 13. Future sanitizer delta ledger

The following additions are selected for later phases and are not applied in
MD-EXT-0:

| Phase | Generated surface | Existing gap | Exact future delta |
| --- | --- | --- | --- |
| MD-EXT-1 TOC | nav, aria-label, role, a, href, ul, li | nav and aria-label absent | Add nav and aria-label only |
| MD-EXT-1 anchors | h1-h6 id and permalink href | already allowed | None |
| MD-EXT-1 lazy images | img loading | already allowed | None |
| MD-EXT-2 details | details open | open absent | Add literal boolean open only for the narrow details {open} feature |
| MD-EXT-5 code groups | button and tab ARIA | button and several ARIA attrs absent | Add button, aria-selected, aria-controls, aria-labelledby, tabindex, and the approved generated aria-label if used |

Existing role, id, class, type, and data policy remain narrow. No wildcard ARIA
allowlist, generic attrs plugin, onclick, style, raw HTML container, or user-defined
data attribute is approved.

## 14. Callouts and container parser decision

Current callouts are implemented by src/lib/callouts.ts as the nuvyn-callouts core
rule. It transforms supported blockquote markers into fixed safe classes/titles;
malformed markers remain ordinary blockquotes. Existing aliases and nesting are
protected by current callout tests.

The selected future container architecture is a Nuvyn-owned narrow block rule,
not markdown-it-container and not generic attrs. Only the PRD-approved built-in
container types are recognized. The parser owns exact nesting, title escaping,
malformed behavior, and deterministic output. Generated classes are fixed by the
application.

The narrow details extension is APPROVED for the later container phase only when
the literal {open} flag is present. It does not approve arbitrary details
attributes or generic HTML attributes. The sanitizer delta is the single open
attribute described above.

Math remains owned by src/lib/math.ts. Its block and inline placeholders must not be
consumed by container or fence parsers.

## 15. Shiki H8 baseline

The H8 migration is complete and closed. Current production Shiki ownership is:

| Owner | Current implementation |
| --- | --- |
| Highlighter | one module-level highlighterPromise/activeHighlighter lifecycle in src/lib/shiki.ts |
| Themes | github-light and github-dark dual-theme data |
| Token style conversion | one module-level transformerStyleToClass instance |
| Generated CSS | one head style element with id nuvyn-shiki-generated-styles |
| Normal fence output | pre.shiki with token spans/classes |
| Unknown/unsupported language | escaped pre.shiki nuvyn-shiki-plain fallback |
| Theme switch | CSS selectors; no Markdown rerender or retokenization |
| Special fences | exact bare markmap and mermaid bypass normal Shiki |
| PDF | settled article clone, copied trusted generated CSS, forced printable light |

The current normal renderer is already Shiki; MD-EXT-0 does not change it. The
future extension phases add annotations, line structure, groups, and resource
expansion around the H8 boundary rather than creating another renderer or
highlighter.

Unknown identifiers remain separate from runtime failures. An unknown language
does not initialize a grammar and uses the existing safe fallback. Bare markmap
and mermaid remain placeholders with data-content=encodeURIComponent(...). Values
such as mermaid{1} and markmap{1} are not exact special fences.

## 16. @shikijs/transformers 4.4.3 audit

The installed package exports the required functions:

~~~text
transformerMetaHighlight
transformerNotationHighlight
transformerNotationFocus
transformerNotationDiff
transformerNotationErrorLevel
transformerStyleToClass
~~~

Observed behavior from the installed source/types:

| Transformer | Input channel | Observed behavior |
| --- | --- | --- |
| transformerMetaHighlight | codeToHtml meta.__raw | parses ranges such as {1,3-5} and adds a line class |
| transformerNotationHighlight | code source | recognizes [!code highlight] and the installed range form |
| transformerNotationFocus | code source | recognizes [!code focus] and focus:N |
| transformerNotationDiff | code source | recognizes ++ and -- line notation |
| transformerNotationErrorLevel | code source | recognizes warning, error, and info |
| transformerStyleToClass | trusted token styles | removes inline style and registers classes/CSS |

The installed notation map accepts a positive numeric suffix and applies the range
from the annotated line. That technical capability does not change the Nuvyn
product decision: highlight:N remains DEFERRED and must be blocked or restricted
at the source-notation boundary in MD-EXT-3. It must never be routed through
parseFenceMeta(info).

The future transformer order is closed as:

~~~text
meta range transformer
restricted single-line notation highlight handling
notation focus
notation diff
notation error-level
one existing transformerStyleToClass instance, last/sole style owner
~~~

The H8 style transformer owns the only mutable CSS registry. Notation factories do
not create a second highlighter or CSS registry. The approved implementation may
construct the notation transformer list through one fixed builder per codeToHtml
invocation; no module-global mutable notation state is allowed. The style
transformer itself remains the singleton already used by H8.

## 17. FenceMeta and source-notation separation

The two metadata channels are independent:

~~~text
FENCE INFO
"ts {1,3-5}:line-numbers [config.ts]"
    ↓
parseFenceMeta(info)
    ↓
FenceMeta
    ↓
language discovery, ranges, line numbers, labels, special-fence classification

CODE SOURCE
const x = 1 // [!code focus:3]
    ↓
Shiki codeToHtml(source, ...)
    ↓
approved source-notation transformer pipeline
~~~

FenceMeta parses only the info string. Its selected conceptual fields are:

~~~ts
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
~~~

FenceMeta may parse language, {1,3-5}, :line-numbers, :no-line-numbers,
:line-numbers=N, and [display label]. It must not parse:

~~~text
[!code highlight]
[!code focus]
[!code focus:N]
[!code ++]
[!code --]
[!code warning]
[!code error]
[!code info]
~~~

Those directives are code-body source notation. Focus:N is bounded at the source
notation validation/transformer boundary with a recommended maximum of 1000.
line-numbers=N is bounded inside parseFenceMeta with a recommended maximum of
100000. Deferred highlight:N is blocked at the source-notation boundary, not the
fence-info parser.

The unified-parser wording therefore means one fence-info parser plus one approved
Shiki notation pipeline, not one parser for every annotation syntax.

## 18. Annotation transformer order and lifecycle

FenceMeta consumers are:

- fence-language discovery;
- normal fence rendering;
- meta range highlighting;
- line-number behavior;
- code-group display labels;
- special-fence classification;
- future snippet explicit-language handling.

FenceMeta is not a source-notation AST. Source notation is consumed per code source
and per codeToHtml invocation. It has no module-global annotation state.

The approved source-notation set is:

~~~text
[!code highlight]
[!code focus]
[!code focus:N]
[!code ++]
[!code --]
[!code warning]
[!code error]
[!code info]
~~~

highlight:N is deferred. If the installed standard highlight transformer activates
it automatically, MD-EXT-3 must use a restricted adapter or a gating preprocessor
at the source-notation boundary. It must not create a second Shiki runtime, second
style registry, or sanitizer exception.

MD-EXT-3 tests must keep fence-info parser cases separate from source-notation
cases. A test description must never imply that parseFenceMeta returns focus,
diff, error-level, or other source-code annotations.

## 19. Numeric bounds and malformed-input policy

| Parameter | Selected value | Enforcement |
| --- | ---: | --- |
| focus:N | maximum 1000 | source-notation validation / approved transformer boundary |
| highlight:N | deferred | source-notation gating boundary |
| line-numbers=N | maximum 100000 | parseFenceMeta(info) |
| extracted snippet | 256 KiB | before decode/Shiki |
| included file | 512 KiB | server read before decode |
| final expanded Markdown | 2 MiB | expansion before final parse |
| include depth | 8 | before recursive read |

N accepts only positive bounded integers. Zero, negative, non-numeric, absurd, and
malformed values are safely ignored or rejected according to the owning channel and
never throw, create arbitrary classes, or create arbitrary HTML. A range beyond the
end of a code block is safely clamped/ignored by the approved transformer semantics.

## 20. Line-number structural feasibility

Current H8 Shiki output already supplies line-level HAST spans. MD-EXT-4 may add
trusted structural markup of this form:

~~~html
<span class="line">
  <span class="nuvyn-line-number" aria-hidden="true">1</span>
  <span class="nuvyn-line-content">...</span>
</span>
~~~

The gutter is structural, not text appended to the code string. It uses fixed
Nuvyn-owned classes and no inline style or user-controlled CSS property. The code
content remains readable/selectable, wrapped lines remain within the code block,
and aria-hidden is limited to the visual number. An HAST transform or equivalent
trusted renderer hook is feasible with the installed Shiki output; MD-EXT-4 must
prove wrapped lines, long lines, PDF pagination, and accessibility behavior before
completion.

## 21. Code-group DOM, sanitizer, and mount decision

MD-EXT-5 will generate static all-panel DOM and enhance it after v-html through a
root-scoped useCodeGroupMount or equivalent. No Vue directives, inline handlers,
HTML template compilation, or tab dependency is approved.

The selected DOM has:

~~~text
nuvyn-code-group [role=group aria-label]
  nuvyn-code-group-tabs [role=tablist]
    button [role=tab id aria-controls aria-selected tabindex]
  nuvyn-code-group-panels
    div [role=tabpanel id aria-labelledby aria-hidden]
      pre/code panel
~~~

All panels remain in sanitized DOM. Reader active state changes only classes and
ARIA state within the current article root. Each render/surface gets a deterministic
internal scope; labels never become raw IDs. PDF expands every labeled panel in
source order and does not reread resources.

The sanitizer delta is the exact button/ARIA delta in section 13. The mount owns
event delegation and teardown; the Markdown renderer owns static markup; Shiki
continues to own token classes.

## 22. Reader theme baseline

src/composables/useTheme.ts currently models only concrete light and dark values.
There is no persisted three-state system value. With no saved theme, the module
observes prefers-color-scheme and writes a concrete data-theme value at module
initialization; set() persists light or dark and updates data-theme.

src/shiki.css provides dual token variables and selectors for:

~~~text
system/OS light and dark through media rules
data-theme="light"
data-theme="dark"
~~~

Explicit data-theme selectors take precedence over the OS media query. Theme
switching is CSS-only and does not rerun Markdown or Shiki tokenization. MD-EXT
features must not create a second theme state or retokenize code.

## 23. PDF baseline

PdfExportSurface.vue renders a separate hidden article with render-theme="light".
That prop is consumed by the RenderedMarkdown widget mount path for Mermaid, MarkMap,
and Math; it does not mutate document.documentElement[data-theme] and is not itself
a global syntax-token palette switch.

src/lib/pdfExport.ts receives already-rendered article HTML, clones it, staticizes
settled widgets, copies the trusted generated Shiki CSS owner into the PDF clone,
sets printable light variables and color-scheme, and passes the result to
html2pdf.js. PDF CSS under .pdf-document forces pre.shiki and nested Shiki token
colors to the light palette, alongside light pre/code background, wrapping, border,
break-inside, and oversized-block rules.

The PDF contract is:

- reader light -> printable-light syntax palette;
- reader dark -> printable-light syntax palette;
- forced dark -> printable-light syntax palette;
- OS dark -> printable-light syntax palette;
- long lines wrap without horizontal clipping;
- oversized code can split where allowed;
- Mermaid, MarkMap, and Math keep their existing settle/staticization behavior;
- PDF does not reread snippet/include resources;
- global reader theme and generated-style ownership are restored/isolated.

Focused H8 browser evidence below proves actual computed token colors in the clone,
not only background existence. MD-EXT changes must preserve that evidence and add
equivalent assertions for new code structure.

## 24. Server authentication and physical path baseline

server/index.ts mounts authBoundary for /api/* before protected routes. Public
health/auth status/setup/login/logout paths are the explicit exceptions. Protected
API requests receive the existing session/CSRF/no-store behavior from
server/auth/middleware.ts.

server/routes/posts.ts is a Markdown-note CRUD/read route and is not a generic
resource endpoint. server/routes/vault.ts serves tree/file-state functions and is
not a generic resource endpoint. No generic Markdown resource or image asset route
exists at this baseline.

server/paths.ts uses CONTENT_DIR (VAULT_DIR or the project content directory) and
provides strict physical safety helpers:

- resolveSafeRelativePathDetailed();
- readSafeRelativeFile();
- no absolute paths, backslashes, dot segments, NULs, trailing/empty segments, or
  raw traversal;
- no symlinked root/intermediate/final path;
- lstat identity, device/inode, no-follow, size, and before/after revalidation;
- bounded reads and AbortSignal support.

These physical helpers intentionally reject dot segments. The MD-EXT logical resolver
must normalize author-relative ./ and ../ first, then pass only a canonical
vault-relative POSIX path with no dot segments. The physical helper must not be
weakened to accept raw traversal syntax.

## 25. Resource endpoint decision

MD-EXT-6 owns a narrow authenticated resource boundary. The selected future module
ownership is:

~~~text
server/markdownResources.ts
server/routes/markdownResources.ts
src/lib/markdownResources.ts
~~~

The selected route family is /api/markdown-resources. It is mounted below the
existing /api/* authBoundary and accepts:

~~~text
canonical vault-relative path
explicit resource kind: snippet | include | image
bounded selection/range data
~~~

It does not accept raw author references, absolute host paths, protocols, browser
filesystem paths, or arbitrary file download requests. It returns generic safe
errors without host paths, stack traces, or raw server messages. The posts route is
not reused.

The server read path is:

~~~text
authenticated request
    ↓
kind/shape validation
    ↓
canonical path validation
    ↓
resolveSafeRelativePathDetailed()
    ↓
readSafeRelativeFile()
    ↓
fatal UTF-8/text policy
    ↓
bounded response
~~~

Relative images are a separate image kind with exact extension/MIME checks; they are
not text-decoded. SVG is excluded initially.

## 26. Resource extension and MIME policy

The initial resource content policy is closed as text-only and UTF-8:

~~~text
Markdown includes:
.md only

Source/text snippets:
.ts .tsx .js .jsx .mjs .cjs .vue .css .scss .less .html .xml .json
.yaml .yml .toml .sql .py .java .go .rs .rb .php .sh .bash .zsh .fish
.c .h .cc .cpp .hh .hpp .cs .kt .kts .swift .dart .lua .r .txt

Extensionless or unlisted text:
rejected in the initial core

Relative image assets:
.png -> image/png
.jpg/.jpeg -> image/jpeg
.gif -> image/gif
.webp -> image/webp
.avif -> image/avif
SVG:
excluded initially
~~~

The exact list is a closed MD-EXT-6 implementation parameter, not a reason to
weaken physical path checks. Files are decoded with fatal UTF-8. Binary content,
invalid UTF-8, unsupported type, directory, symlink, missing, or oversized input
returns a generic local resource error; no lossy Buffer.toString fallback is
allowed.

## 27. Logical path and source-provenance decision

The two-stage model is mandatory:

~~~text
author reference
    ↓
resolveLogicalResourceReference(sourcePath, reference)
    ↓
canonical vault-relative logical path
    ↓
existing physical safe resolver
~~~

Authors may use ./ and ../ relative to the current Markdown source document. The
logical layer may consume dot segments only while normalizing. The canonical result:

- uses / separators;
- contains no . or .. segments;
- remains strictly inside the configured root;
- rejects root escape;
- is the only form passed to the physical helper.

Before/after normalization, reject absolute Unix/Windows/UNC paths, drive letters,
backslashes, NUL/control characters, file://, http://, https://, other URI schemes,
empty paths, and root escape. A syntactic ../ is not inherently forbidden; escape
from the configured root is forbidden.

The logical source context is a per-render ExpandedSegment:

~~~text
text
sourcePath
sourceKind: root | include
sourceLineStart
~~~

The future resolver may accept an optional source context, preserving existing
two-argument callers. Context is per render and is carried by an opaque
render-scoped marker or equivalent internal table; module-global current-source
state is forbidden. Included WikiLinks, relative links, images, and nested
includes use the included source directory.

## 28. Include limits, regions, cycles, and errors

The selected MD-EXT-6 behavior is:

- expand snippets/includes before final fence discovery and Shiki preparation;
- parse references outside code spans and fenced code;
- support nested includes;
- use canonical logical paths for cycle identity;
- allow duplicate non-cyclic includes;
- use a per-render bounded read cache keyed by canonical path, kind, and selection;
- apply 256 KiB snippet, 512 KiB include, 2 MiB final expansion, and depth-8 limits;
- use positive one-based inclusive line ranges;
- use named regions with matching start/end markers, strip marker lines, and
  concatenate repeated matching regions in source order;
- missing, malformed, unclosed, mismatched, out-of-range, oversized, and cyclic
  selections produce a safe local escaped error rather than a document-wide crash;
- never expose absolute paths, stack traces, or raw server errors;
- preserve sourcePath/sourceLineStart provenance after expansion.

The expansion order is:

~~~text
frontmatter/body parse
    ↓
safe expansion and context-preserving rewrite
    ↓
limits/cycles/regions
    ↓
final fence discovery
    ↓
Shiki preparation
    ↓
MarkdownIt render
    ↓
sanitize
~~~

No resource read occurs inside a synchronous fence renderer. PDF receives settled
article HTML and never rereads resource paths.

## 29. Cancellation, concurrency, and state

Current useMarkdownRender uses stale-result cancellation: an obsolete async render
cannot publish HTML/headings over a newer render. This remains mandatory when
resource expansion is introduced.

The state ownership decisions are:

| State | Ownership |
| --- | --- |
| MarkdownIt plugins/rulers | one module singleton |
| Shiki highlighter/style registry | one module singleton |
| language preparation | existing single-flight runtime/language state |
| heading collisions | per-render allocator/env |
| FenceMeta | per fenced block, info string only |
| source notation | per codeToHtml source invocation |
| resource expansion | per render, bounded cache and cycle stack |
| source provenance | per-render ExpandedSegment |
| code-group active tab | per article/surface root |
| PDF clone state | per export operation |

Concurrent renders must not share heading collision state, source context, code-group
state, or mutable notation state. A resource read may be deduplicated within one
render but must not leak data or cancellation state to another render. AbortSignal
must stop obsolete resource work and cannot turn a newer render into a stale result.

## 30. Test and validation baseline

### 30.1 Focused unit baseline

Command:

~~~text
./node_modules/.bin/vitest run \
 src/lib/__tests__/markdown.test.ts \
 src/lib/__tests__/shiki.test.ts \
 src/lib/__tests__/wikiLinks.test.ts \
 src/lib/__tests__/callouts.test.ts \
 src/lib/__tests__/math.test.ts \
 src/lib/__tests__/markmapSecurity.test.ts \
 src/composables/vault/__tests__/useMarkdownRender.test.ts \
 src/components/vault/__tests__/PdfExportSurface.test.ts \
 src/components/__tests__/MarkMap.test.ts \
 src/components/__tests__/MarkMapSecurity.test.ts \
 src/components/__tests__/Mermaid.test.ts \
 src/lib/__tests__/pdfExport.test.ts \
 src/lib/__tests__/pdf-readiness.test.ts \
 server/__tests__/paths.test.ts \
 server/__tests__/auth-middleware.test.ts \
 src/lib/__tests__/aiMarkdown.test.ts
~~~

Result:

~~~text
PASS
16 test files passed
261 tests passed
exit code 0
~~~

The focused run emitted a jsdom warning about an unparseable CSS stylesheet in
existing test setup; it did not fail a test.

The focused inventory maps the current protection surface:

| Contract | Current tests |
| --- | --- |
| normal Shiki fence and plain fallback | src/lib/__tests__/markdown.test.ts, shiki.test.ts |
| HTML/style/event/URI sanitizer | markdown.test.ts, markmapSecurity.test.ts, browser security spec |
| WikiLink/internal .md resolver | wikiLinks.test.ts, markdown.test.ts |
| callout coexistence | callouts.test.ts |
| math placeholders | math.test.ts |
| MarkMap security and mount | markmapSecurity.test.ts, MarkMap.test.ts, MarkMapSecurity.test.ts |
| Mermaid mount | Mermaid.test.ts |
| async render/stale publication/page headings | useMarkdownRender.test.ts |
| PDF HTML/CSS/staticization/readiness | pdfExport.test.ts, pdf-readiness.test.ts, PdfExportSurface.test.ts |
| physical path/symlink/race checks | server/__tests__/paths.test.ts |
| auth boundary | server/__tests__/auth-middleware.test.ts |
| isolated AI Markdown surface | aiMarkdown.test.ts |

MD-EXT-1 through MD-EXT-6 must preserve these tests and add phase-specific cases
without changing the existing contracts opportunistically.

### 30.2 Full unit baseline

Command:

~~~text
npm run test:unit
~~~

Actual result:

~~~text
FAIL, exit code 1
Test Files: 4 failed | 207 passed (211)
Tests: 22 failed | 3097 passed | 2 skipped (3121)
Duration: 21.36s
~~~

The failures were:

1. server/__tests__/openai-http.test.ts: 19 tests failed because the test child
   could not listen on 127.0.0.1; error signature:
   listen EPERM: operation not permitted 127.0.0.1.
2. server/__tests__/round15FolderMoveRecoveryClosure.test.ts: crash child could
   not create its tsx IPC pipe; error signature:
   listen EPERM: operation not permitted /var/folders/.../tsx-...pipe.
3. server/__tests__/round16FolderMoveCoordinatorClosure.test.ts: same tsx IPC pipe
   EPERM before its READY marker.
4. server/__tests__/auth-middleware.test.ts: expected 200, received 500 while
   reading the tree; stderr reported ENOENT for
   /Users/txx/nuvyn/src/content/delete-empty-path.md.

These failures are outside the Markdown extension surface. The listener/IPC
failures are environment restrictions in the audit runner. The missing content
fixture has the same shared-content cleanup/race signature seen in the existing
server baseline and is independent of Markdown/Shiki code. No focused
Markdown/Shiki/resource-related test failed. The command remains recorded as FAIL,
not PASS; later release evidence must rerun the full suite in a suitable CI/runtime
environment and must not inherit this limitation without review.

### 30.3 Typecheck and build

~~~text
npm run typecheck
PASS, exit code 0
  npm run typecheck:client -> vue-tsc --noEmit -p tsconfig.app.json
  npm run typecheck:server -> tsc --noEmit -p tsconfig.server.json

npm run build
PASS, exit code 0
  vue-tsc -b && vite build
  vite 8.0.16
  3930 modules transformed
  built in 1.26s
~~~

Build warnings retained as baseline:

- Rolldown INVALID_ANNOTATION warnings for existing @vueuse/core pure comments;
- existing chunks larger than 500 kB after minification.

No source or dependency changed to address those warnings.

## 31. Browser and PDF baseline

The first browser attempt was blocked by the sandbox when the Playwright webServer
tried to listen on 127.0.0.1:4174. The same commands were then run with controlled
loopback permission; the application and tests were unchanged.

Focused contract set:

~~~text
npm run test:e2e -- \
 e2e/markdown-shiki-security.spec.ts \
 e2e/markdown-shiki-theme.spec.ts \
 e2e/pdf-export-shiki.spec.ts
~~~

Result:

~~~text
PASS
3 tests passed
exit code 0
~~~

Broader Markdown/MarkMap/PDF set:

~~~text
npm run test:e2e -- \
 e2e/markdown-visual.spec.ts \
 e2e/markmap-math.spec.ts \
 e2e/pdf-export-compat.spec.ts \
 e2e/pdf-export-cors.spec.ts \
 e2e/pdf-export-layout.spec.ts \
 e2e/pdf-export-long-document.spec.ts \
 e2e/pdf-export-pagination.spec.ts \
 e2e/pdf-export-stress.spec.ts \
 e2e/pdf-export.spec.ts
~~~

Result:

~~~text
PASS
22 tests passed
exit code 0
~~~

The H8 browser evidence proves:

- Shiki token classes and generated CSS stay outside sanitized article HTML;
- light/dark reader token/background palettes are selected by CSS without rerender;
- PDF clones force printable-light computed Shiki token colors across the reader
  theme matrix;
- MarkMap, Mermaid, Math, images, long documents, wide tables, huge code,
  pagination, and stress export remain settled and printable.

## 32. Pre-MD-EXT production bundle baseline

This is the PRE-MD-EXT bundle baseline from the successful npm run build. dist is
ignored build output and was not added to the task diff.

| Asset | Raw bytes | Gzip bytes | Purpose |
| --- | ---: | ---: | --- |
| dist/assets/EditorPane-DmWG4FKy.js | 3,648,931 | 921,510 | editor surface |
| dist/assets/VaultView-brT1zakg.js | 1,867,839 | 527,445 | reader/vault surface |
| dist/assets/index-Dnx_YGkk.js | 231,721 | 77,312 | application entry |
| dist/assets/github-light-EUqPIrTm.js | 11,181 | 2,543 | Shiki light theme chunk |
| dist/assets/github-dark-C-LZuMrd.js | 11,402 | 2,581 | Shiki dark theme chunk |
| dist/assets/javascript-Cb010CKM.js | 174,882 | 16,667 | lazy grammar chunk |
| dist/assets/typescript-C17ZkDe8.js | 181,135 | 16,176 | lazy grammar chunk |
| dist/assets/python-gzcpVVnB.js | 69,945 | 9,169 | lazy grammar chunk |
| dist/assets/java-D4RbCvBe.js | 27,274 | 4,333 | lazy grammar chunk |
| dist/assets/sql-DGnQv6iD.js | 23,483 | 7,506 | lazy grammar chunk |
| dist/assets/index-B37GQG0h.css | 133,950 | 27,093 | main CSS |

Build inventory:

~~~text
asset files: 467
JavaScript assets: 404
largest raw assets include EditorPane 3.65 MB, VaultView 1.87 MB,
emacs-lisp 790.00 kB, cpp 785.53 kB, wasm 622.33 kB
~~~

Shiki themes and grammars are separate assets rather than one eager all-language
payload. MD-EXT-7 must compare logical surfaces, not only hashes, and must prove
that later resource/client work does not pull server filesystem code into the
browser bundle or add a second parser/highlighter.

## 33. Open/closed implementation parameter table

No implementation-critical parameter remains UNKNOWN or TBD after this audit.

| Parameter | Decision | Owner phase |
| --- | --- | --- |
| Anchor duplicate suffix | uniqueSlugStartIndex: 2; id/id-2/id-3 | MD-EXT-1 |
| Heading allocator | one per-render anchor-backed allocator | MD-EXT-1 |
| Explicit anchor grammar | only {#safe-id}; generic attrs rejected | MD-EXT-1 |
| TOC | token/core, standalone [[toc]], h2-h4 | MD-EXT-1 |
| Generated external links | HTTP(S) Markdown/linkify only, target blank, rel noopener noreferrer | MD-EXT-1 |
| Raw HTML external anchors | existing sanitizer/raw HTML contract unchanged | MD-EXT-1 |
| Markdown images | loading lazy only for generated image tokens | MD-EXT-1 |
| Containers | Nuvyn-owned narrow parser; no generic dependency | MD-EXT-2 |
| details | literal {open} only; sanitizer adds open | MD-EXT-2 |
| FenceMeta | info string only | MD-EXT-3 |
| Source notation | approved Shiki transformers; separate channel | MD-EXT-3 |
| focus:N | max 1000, source boundary | MD-EXT-3 |
| highlight:N | deferred | MD-EXT-3 |
| line-numbers=N | max 100000, fence parser | MD-EXT-4 |
| Line DOM | structural trusted gutter/content spans | MD-EXT-4 |
| Code groups | static all-panel DOM plus root-scoped mount | MD-EXT-5 |
| Resource service/route/client | server/markdownResources.ts, server/routes/markdownResources.ts, src/lib/markdownResources.ts | MD-EXT-6 |
| Resource endpoint | authenticated /api/markdown-resources | MD-EXT-6 |
| Resource path | logical normalize, then strict physical resolver | MD-EXT-6 |
| Text resource policy | UTF-8, fatal decode, explicit allowlist; binary rejected | MD-EXT-6 |
| Markdown include extension | .md | MD-EXT-6 |
| Snippet extensions | explicit source/text allowlist in section 26 | MD-EXT-6 |
| Image MIME policy | png/jpeg/gif/webp/avif; SVG excluded | MD-EXT-6 |
| Snippet/include limits | 256 KiB / 512 KiB / 2 MiB final / depth 8 | MD-EXT-6 |
| Source provenance | per-render ExpandedSegment | MD-EXT-6 |
| PDF resources | no reread; use settled article HTML | MD-EXT-6/7 |

## 34. Risks, blockers, and stop conditions

### 34.1 Closed risks

- Installed anchor default differs from the product suffix convention; the future
  explicit value and audit proof close the ambiguity.
- Standard Shiki notation technically supports highlight:N; the product boundary
  explicitly defers it and assigns gating to source notation.
- Physical path helpers reject dot segments; the two-stage logical model preserves
  that security boundary.
- Existing WikiLink renderer ownership could be overwritten by external-link logic;
  the required composition order closes that risk.
- Current sanitizer lacks future nav/open/button attributes; the exact delta ledger
  prevents broad allowlisting.
- Source context cannot be global; ExpandedSegment and render-scoped markers close
  the provenance model.

### 34.2 Non-blocking environment limitations

The full unit command's four failing files and 22 tests are recorded in section
30.2. They are not MD-EXT product failures and did not occur in the focused
Markdown/Shiki/PDF baseline or browser suites. They remain a release-validation
follow-up for an environment with loopback/IPC permissions and stable shared
content fixtures.

### 34.3 Mandatory later stop conditions

Stop the owning phase and review the PRD if:

- custom anchors require generic attributes or a second slugger;
- TOC reparses Markdown or invents IDs;
- external-link policy overwrites WikiLink ownership or rewrites raw HTML;
- any notation restriction needs a second Shiki runtime/style registry or inline
  style;
- line numbers require dynamic user CSS or inaccessible duplicated code text;
- code groups require Vue compilation inside v-html or export only the active panel;
- resource handling passes raw dot segments to server/paths.ts;
- resource auth/root/symlink confinement cannot be proven;
- resource expansion occurs after Shiki discovery;
- source provenance requires module-global mutable state;
- binary/invalid UTF-8 is decoded lossily;
- errors disclose host paths or stacks;
- a second MarkdownIt/Shiki runtime appears in the bundle;
- Mermaid, MarkMap, Math, PDF, or existing H8 contracts regress.

## 35. MD-EXT-0 verdict

~~~text
MD-EXT-0: COMPLETE
Implementation: NOT STARTED
MD-EXT-1: NOT STARTED
Production code changed in this phase: NO
Tests changed in this phase: NO
Dependencies changed in this phase: NO
PRD changed in this phase: NO
PDF/DOMPurify behavior changed in this phase: NO
~~~

The audit is complete with the full-unit environmental limitations explicitly
recorded. No product-semantic discrepancy requires PRD review before MD-EXT-1.

## 36. MD-EXT-1 entry criteria

MD-EXT-1 may start only after this evidence is reviewed. Its first implementation
commit must:

- keep 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 as the immutable implementation
  baseline;
- configure markdown-it-anchor with uniqueSlugStartIndex: 2;
- prove the one per-render allocator for automatic/custom/included collisions;
- add only the approved narrow custom-anchor grammar;
- compose generated external-link policy with the existing WikiLink renderer;
- add only the approved TOC/lazy-image sanitizer behavior;
- preserve current H8 Shiki, Mermaid, MarkMap, Math, PDF, and AI Markdown tests;
- record its own phase base/completion SHA and forbidden-scope audit.

MD-EXT-0 does not authorize MD-EXT-1 automatically. The next state is:

~~~text
MD-EXT-0 — COMPLETE
MD-EXT-1 — READY / NOT STARTED
~~~
