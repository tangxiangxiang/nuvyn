# Nuvyn VitePress-Style Markdown Extensions Implementation Plan

## 1. Document Information

| Field | Value |
| --- | --- |
| Document status | IMPLEMENTATION COMPLETE / MD-EXT-7 COMPLETE / REVIEW-CLOSED |
| Product program | Nuvyn VitePress-Style Markdown Extensions |
| Repository | tangxiangxiang/nuvyn |
| Branch | main |
| Plan date | 2026-08-21 |
| Product production baseline | c32f5bc9c1597c6c2f6b3e9581f327636fe8d8c2 |
| Approved PRD baseline | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Implementation Plan task base | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Current phase | MD-EXT-7 — COMPLETE / REVIEW-CLOSED; MD-EXT PROGRAM — COMPLETE / REVIEW-CLOSED |
| Current implementation state | PRD approved; MD-EXT-0 audit complete; MD-EXT-1 implementation and provenance/source-awareness follow-up complete; MD-EXT-2 implementation plus opaque-range and paragraph-context follow-ups complete; MD-EXT-3 fence metadata and Shiki source annotations plus sentinel/budget review follow-up complete; MD-EXT-4 bounded structural line numbers, unknown-language fallback, reader/PDF layout, browser evidence, and reader annotation-background follow-up complete; MD-EXT-5 static code groups, root-scoped reader enhancement, sanitizer delta, and all-panel PDF preparation complete; MD-EXT-6 safe snippets/includes, authenticated resource reads, exact range semantics, exact UTF-8 expansion accounting, per-child source context, cancellation, code-span-aware directive opacity, fail-closed local-image PDF cloning, and child-driven Markdown-link/image ownership complete; MD-EXT-7 full regression, browser/PDF, security, architecture, bundle, and documentation release gate complete / review-closed |
| Shiki prerequisite | SHIKI-H0 through SHIKI-H8 COMPLETE; migration closed; no H9 |
| Parser baseline | markdown-it 14.2.0 singleton (package range `^14.1.0`) |
| Shiki baseline | Shiki 4.4.3, @shikijs/transformers 4.4.3 |
| VitePress reference | Official Markdown Extensions documentation, version observed 2.0.0-alpha.19 on 2026-08-21 |
| Scope of this document | Implementation planning only |
| This lifecycle update changes | MD-EXT-7 release-gate evidence and final COMPLETE / REVIEW-CLOSED lifecycle metadata; MD-EXT PROGRAM is COMPLETE / REVIEW-CLOSED |

The production baseline is the last production-code state before this Markdown
extension program. The approved PRD commits after that point are documentation-only.
The Plan task base is the repository state from which this plan is created. These
three references must not be collapsed into one “current baseline”.

The implementation baseline is the exact approved-plan commit recorded by MD-EXT-0:
582e312a4c5752a4c9a5c6bba7b0e752b0b78078. The evidence document records the same
SHA as its audit HEAD and MD-EXT-0 base. The later evidence commit is documentation
only and does not replace the implementation baseline.

## 2. Planning Goals and Constraints

This plan answers, phase by phase:

- what behavior is added and what existing behavior is protected;
- why each change belongs in its phase;
- which current files own the behavior;
- which new narrow modules may be introduced;
- what the sanitizer, Shiki, reader, server, and PDF boundaries are;
- which tests prove each contract;
- where a phase can be rolled back independently;
- what evidence must be recorded before the next phase starts;
- which conditions require stopping for PRD review.

The PRD at docs/design/vitepress-markdown-extensions-prd.md is authoritative. This
plan may choose an implementation mechanism, but it may not silently change syntax,
security, routing, deferred scope, or PDF semantics. If implementation work reveals a
product conflict, work stops, the conflict is documented, and the PRD is reviewed
before the affected phase continues.

The original plan and MD-EXT-0 audit commits were planning/evidence-only. The current
lifecycle records the reviewed completion of MD-EXT-1, MD-EXT-2, and MD-EXT-3,
including their focused corrective follow-ups and evidence.
The completed MD-EXT-6 phase, including its review follow-up:

- does not add or remove dependencies;
- keeps the DOMPurify boundary and FORBID_ATTR: ['style'] invariant;
- adds only the authenticated, canonical-path resource endpoint required by MD-EXT-6;
- charges every resource expansion insertion against the exact final UTF-8 byte
  budget, while retaining per-render read caching;
- maps source context to each merged inline child by its flattened source line;
- keeps standalone-looking resource directives opaque inside variable-length,
  multi-line inline code spans without introducing a second full Markdown parser;
- binds raw-source code-span ownership to the complete actual MarkdownIt child
  sequence, so exact `html_inline` ranges cannot be claimed by later
  `code_inline` children with identical normalized content;
- consumes a normal Markdown link label through its actual child sequence before
  `link_close` confirms the current outer `]`; destination/title helpers run only
  after that proof, and raw-source ownership never moves backwards;
- consumes image alt ownership from MarkdownIt's existing `image.content` and
  `image.children`, maps nested code ranges into outer coordinates, and derives
  the outer image close from the parser-owned alt length rather than scanning
  future `]` characters;
- keeps settled local PDF resource images inside the export boundary so the
  browser makes no second resource-endpoint request;
- omits local resource image source attributes from the PDF clone when snapshot
  materialization fails, so the authenticated endpoint can never be restored;
- does not start MD-EXT-7;
- does not reopen the completed Shiki migration.

## 3. Authoritative PRD and Baselines

### 3.1 Three baselines

| Baseline | SHA | Meaning |
| --- | --- | --- |
| Product production baseline | c32f5bc9c1597c6c2f6b3e9581f327636fe8d8c2 | Last production-code state before the Markdown Extensions PRD |
| Approved PRD baseline | 7e05e3bb43f4283a90ead1abd0c81325bc93281c | Frozen product contract consumed by this plan |
| Plan task base | 7e05e3bb43f4283a90ead1abd0c81325bc93281c | HEAD at plan creation |

MD-EXT-0 records a fourth operational reference:

| Evidence field | Value |
| --- | --- |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| MD-EXT-0 base | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| MD-EXT-0 evidence | [Baseline & Compatibility Contract Audit](vitepress-markdown-extensions-md-ext-0-audit.md) |
| Previous phase completion | Recorded separately for every later phase |

No future commit SHA is written into this document. A phase evidence document must
never claim that a command ran at a commit created after the command was run.

### 3.2 Product authority

The PRD freezes:

- MarkdownIt and its async preparation boundary;
- one existing Shiki runtime and class-based stylesheet owner;
- DOMPurify as the final article boundary with FORBID_ATTR: ['style'];
- Nuvyn WikiLink and vault routing semantics;
- special Mermaid and MarkMap fences;
- reader theme and printable-light PDF behavior;
- two-stage logical-to-physical resource resolution;
- approved, deferred, and rejected compatibility rows.

The official VitePress page supplies author-facing reference syntax. It does not
override Nuvyn security or runtime behavior. The plan records source labels precisely:
heading/section includes and code-file inclusion inside fences are documented by
VitePress but remain deferred Nuvyn candidates.

## 4. Frozen Architecture Decisions

| Topic | Frozen decision | Consequence |
| --- | --- | --- |
| Markdown parser | Keep markdown-it 14.x | No MDX, markdown-it-async, VitePress runtime, or parser replacement |
| MarkdownIt lifecycle | One singleton | Plugins and rules are installed once; render state stays in env/tokens |
| Render API | Keep async Promise<string> | Async work occurs before synchronous MarkdownIt render |
| MarkdownIt render | Synchronous after preparation | No filesystem/resource read inside a fence renderer |
| DOMPurify | Remains the final sanitizer | Every generated article string crosses the same boundary |
| Style security | FORBID_ATTR: ['style'] remains unchanged | Shiki and extensions must use trusted classes/structural attributes |
| Generic attributes | Rejected | No markdown-it-attrs or equivalent generic id/class/style/event grammar |
| Raw container | Rejected | ::: raw cannot create a sanitizer bypass |
| Vue in Markdown | Rejected | v-html output is static HTML; Vue directives are never compiled |
| VitePress runtime/router | Rejected | Syntax familiarity only; Nuvyn /vault routing remains authoritative |
| Shiki runtime | Reuse the H8 singleton | No second highlighter or extension-specific tokenizer |
| Shiki style transformer | Reuse the one transformerStyleToClass instance | No per-block or per-document trusted style registry |
| Shiki CSS owner | One trusted generated stylesheet in document head | Article HTML never receives a generated style tag |
| Theme switching | CSS-only | No Markdown rerender or Shiki retokenization on theme change |
| Shiki language preparation | Final source is discovered before render | MD-EXT-6 expansion must complete before final fence discovery |
| MarkMap | Exact special-fence bypass/lifecycle remains | It never enters normal Shiki annotation or group parsing |
| Mermaid | Exact special-fence bypass/lifecycle remains | mermaid remains a mount placeholder, not a code sample |
| Math | Existing placeholder and mount lifecycle remains | No extension parser may consume math source |
| WikiLinks | Existing Nuvyn resolver and /vault target model remains | New generated-link policy must compose with wikiLinkPlugin |
| Heading IDs | One per-render final allocator | Auto, custom, included headings, TOC, page-nav, permalinks, and PDF share it |
| TOC | Token/core based | It does not regex raw Markdown, render a second document, or invent IDs |
| Containers | Narrow Nuvyn-owned parser recommended | Built-in types only; no generic registration or arbitrary class names |
| Fence metadata | One fence-info parser (`parseFenceMeta(info)`) consumed by discovery/rendering, plus one approved Shiki source-notation transformer pipeline | Never merge fence info with code-body `[!code ...]` notation |
| Annotation range | focus:N is in scope; highlight:N is deferred | Technical Shiki capability does not expand approved product scope |
| Line numbers | Structural trusted markup | No inline custom property, dynamic user CSS, or gutter text in accessible code |
| Code groups | Static all-panel HTML plus post-v-html enhancement | Reader interaction never relies on Vue directives inside v-html |
| Code-group state | Per rendered DOM root | No global active-tab state and no duplicate listeners |
| PDF code groups | Export every panel in source order | Reader active tab does not control export contents |
| Resource paths | Logical source-relative normalization, then physical safe resolver | Physical helpers never receive raw dot segments |
| Resource root | Configured Nuvyn vault/resource root only | No host-root, browser filesystem, or remote URL semantics |
| Resource content | Initial text resources are UTF-8 and allowlisted | Binary/invalid UTF-8 resources fail safely |
| Remote resources | Forbidden | No SSRF or network include feature |
| Include expansion | Before final fence discovery and Shiki preparation | Included languages and headings participate in the final document |
| Include source context | Preserved by a per-render expansion representation | No module-global current document path |
| Resource cache | Per render/request only | No unbounded cross-user global cache |
| Async cancellation | Preserve useMarkdownRender stale-result protection | A newer document can cancel/ignore old resource work |
| Reader page-nav | May continue reading final HTML h2-h4 IDs | It consumes the final IDs and does not create a second slugger |
| PDF resource behavior | Reuse already-expanded/rendered article HTML plus export-only settled-image materialization | PDF does not reread resource files, re-run include expansion, or make a second local-image endpoint request |
| Dependencies | Prefer existing dependencies and Nuvyn-owned narrow code | Any new dependency requires MD-EXT-0 review and bundle/security evidence |
| Program namespace | MD-EXT-0 through MD-EXT-7 | There is no H9, SHIKI-H9, MDX-*, or VP-MD-* phase |

## 5. Current Production Call Flow

The audited H8 + MD-EXT-4 current flow is:

~~~text
raw post source
    ↓
parseDoc() in src/lib/frontmatter.ts
    ↓
useMarkdownRender() in src/composables/vault/useMarkdownRender.ts
    ↓
render(markdown, options) in src/lib/markdown.ts
    ↓
getMd() → one MarkdownIt 14.2.0 singleton (package range `^14.1.0`)
    ↓
md.parse(markdown, isolated discovery env)
    ↓
discoverFenceMetas() → FenceMeta[]
    ↓
prepareShikiLanguages()
    ↓
fresh real WikiLink env
    ↓
md.render(markdown, env)
    ↓
MarkdownIt block/core token pipeline
    ├─ final heading IDs/TOC, Nuvyn container tokens, and static code-group tokens
    ├─ existing callout/math/WikiLink body tokens
    └─ renderFence() / code-group fence wrapper
        ├─ exact markmap → encoded .markmap-mount placeholder
        ├─ exact mermaid → encoded .mermaid-mount placeholder
        └─ normal fence → FenceMeta → Shiki codeToHtml()
             ├─ official meta/notation classes
             ├─ Nuvyn deferred-notation gate
             ├─ opt-in nuvyn:line-numbers structural transform
             └─ escaped plain fallback, with the same line structure when enabled
    ↓
syncGeneratedShikiStylesheet()
    ↓
sanitizeMarkdownHtml() / DOMPurify
    ↓
RenderedMarkdown.vue → v-html
    ↓
useMarkmapMount / useMermaidMount / useMathMount / useCodeGroupMount
    ↓
ReadingPane / RightRail page-nav or PdfExportSurface
    ↓
PDF readiness, clone/staticization, and html2pdf.js when exporting
~~~

Current facts that later phases must preserve:

- src/lib/markdown.ts owns the MarkdownIt singleton and the final sanitize boundary.
- The current MarkdownRenderOptions type contains resolver only; sourcePath and a
  resourceResolver do not yet exist.
- H2 parses MarkdownIt fence tokens with an isolated WikiLink env before final render;
  MD-EXT-3 parses each fence info string through the single FenceMeta parser.
- H8 uses the same parsed source again for final synchronous render.
- src/lib/shiki.ts passes the approved annotation pipeline to codeToHtml and keeps the
  one styleTransformer last and shared. When FenceMeta enables line numbers, a
  per-fence structural code hook wraps the existing `.line` children after the
  annotation hooks and before that shared style transformer.
- src/lib/markdown.ts preserves the unnumbered plain fallback and emits the same
  normalized logical-line contract for numbered unknown-language fences.
- src/lib/fenceMeta.ts owns fence-info metadata only; source `[!code ...]` notation is
  consumed by Shiki transformers and is not stored in FenceMeta.
- MarkMap and Mermaid are exact, case-sensitive special identifiers before normal
  Shiki language resolution.
- useMarkdownRender extracts h2-h4 page-nav entries from final HTML. It does not
  generate a second slug.
- ReadingPane publishes those entries to a Vault-scoped useTocState and RightRail
  renders the page-nav controls.
- RenderedMarkdown inserts sanitized HTML with v-html and mounts Vue widgets only after
  the article exists in the DOM.
- PdfExportSurface uses render-theme="light" for mountable widgets; this is not a
  global document theme mutation.
- src/lib/pdfExport.ts clones already-rendered HTML, copies the trusted Shiki CSS
  snapshot into its own PDF stylesheet owner, staticizes Mermaid/MarkMap, and applies
  printable wrapping/pagination rules.
- There is no current Markdown resource endpoint for arbitrary source files.

### 5.1 Current MarkdownIt plugin/rule order to preserve and extend

The current setup in src/lib/markdown.ts installs, in source order:

1. markdown-it-task-lists;
2. markdown-it-anchor;
3. markdown-it-footnote;
4. markdown-it-deflist;
5. markdown-it-mark;
6. wikiLinkPlugin;
7. calloutPlugin;
8. markdownContainersPlugin (named block insertion before `paragraph`);
9. markdownCodeGroupsPlugin (named insertion before `nuvyn-container`);
10. mathPlugin;
11. @mdit/plugin-emoji;
12. table renderer overrides.

The current installed 14.2.0 block ruler now contains the Nuvyn container rule at
the named position `... deflist, nuvyn-container, paragraph, inline`; the rule is
registered with `before('paragraph', ...)`, not an incidental numeric index. The
container body reuses the same block tokenizer and final render env.

### 5.2 Current sanitizer boundary

The current sanitizer in src/lib/markdown.ts allows semantic article tags including
div, details, summary, pre, code, span, section, lists, tables, img, and a. It allows
class, id, href, src, target, rel, role, aria-hidden, loading, the narrow boolean
`open`, and four Nuvyn data attributes. Its hook removes event attributes and keeps only:

~~~text
data-anchor
data-content
data-missing
data-target
~~~

It forbids style, script/style/iframe/object/embed/form/link/meta/base/math/svg and
uses a Nuvyn URI policy. MD-EXT-2 added only `open` for the literal details `{open}`
feature. Later phases may propose narrowly reviewed additions; none may remove
FORBID_ATTR: ['style'] or enable wildcard data-/aria-/attribute behavior.

## 6. Target End-State Call Flow

After the approved MD-EXT-6 core is implemented, the target flow is:

~~~text
raw post source
    ↓
parseDoc()
    ↓
useMarkdownRender()
    ↓
render(markdown, { resolver, sourcePath, resourceResolver, signal, renderScope })
    ↓
resolveResources() when resource options are present
    ├─ parse snippet/include directives outside code
    ├─ logical source-relative resolution
    ├─ canonical vault-root-relative path
    ├─ authenticated physical resolver
    ├─ bounded UTF-8 text read
    ├─ nested expansion with source provenance
    └─ relative link/image rewriting and safe resource placeholders
    ↓
discover final fence tokens
    ↓
prepareShikiLanguages() for final expanded source
    ↓
MarkdownIt render
    ├─ one final heading-ID allocator and custom anchors
    ├─ token-based [[toc]]
    ├─ Nuvyn-generated HTTP(S) link policy
    ├─ generated Markdown image loading="lazy"
    ├─ built-in containers
    ├─ one fence-info parser plus approved Shiki source-notation transformers
    ├─ Shiki annotations and optional line-number structure
    ├─ code-group static HTML
    ├─ existing WikiLinks, callouts, math, emoji, tables, and footnotes
    ├─ exact Mermaid placeholder
    └─ exact MarkMap placeholder
    ↓
sync one trusted generated Shiki stylesheet
    ↓
DOMPurify
    ↓
v-html
    ↓
post-render enhancements
    ├─ existing Mermaid / MarkMap / math
    └─ Nuvyn code-group interaction
    ↓
reader / PDF
~~~

MD-EXT-6 does not make the PDF surface independently reread resource paths. The PDF
surface receives the same already-expanded source context through the render pipeline,
waits for the same image/widget readiness contract, and exports the settled HTML. The
review follow-up additionally keeps already-settled same-origin local resource images
self-contained in the export clone and excludes live reader article roots from the
html2canvas clone, so browser network evidence shows no second image-endpoint request.

## 7. Current File and Responsibility Inventory

| File / module | Current responsibility | First MD-EXT phase allowed to modify it | Later-phase constraint |
| --- | --- | --- | --- |
| package.json | Existing MarkdownIt, anchor, Shiki, DOMPurify, Vue, PDF, and test scripts/dependencies | MD-EXT-0 may audit; MD-EXT-7 may change only if approved | No VitePress/MDX dependency; any addition needs evidence |
| package-lock.json | npm resolution for the current dependency graph | MD-EXT-0 may audit; only a reviewed dependency phase may change it | Never edit for convenience |
| src/lib/markdown.ts | MarkdownIt singleton, sanitizer, container registration, fence callback, parse/render boundary | MD-EXT-1 / MD-EXT-2 | Keep async preparation before synchronous render |
| src/lib/markdownContainers.ts | Nuvyn-owned fixed-type block parser, title tokens, delimiter matching, nested body tokenization | MD-EXT-2 | No generic attrs, arbitrary types, or module-global parser state |
| src/lib/markdownCodeGroups.ts | Narrow labeled-fence code-group block rule and static tab/panel renderer | MD-EXT-5 | Reuses ordinary fence tokens; no second parser/highlighter |
| src/lib/shiki.ts | Shiki singleton, language loading, codeToHtml, style transformer, generated CSS, and the MD-EXT-4 structural line transform | MD-EXT-3 / MD-EXT-4 | Keep one highlighter and style registry |
| src/lib/wikiLinks.ts | [[...]] inline rule and standard .md link_open classifier/renderer | MD-EXT-1 | External policy must compose with this renderer |
| shared/linkResolve.ts | Isomorphic Nuvyn note target resolution | MD-EXT-6 only if source-context extension is required | Preserve current no-escape semantics |
| src/lib/callouts.ts | Obsidian blockquote callouts and aliases | MD-EXT-0 audit only; MD-EXT-2 only for a proven coexistence fix | Do not replace callout syntax |
| src/lib/math.ts | Math placeholders and encoded source | MD-EXT-0 audit only | No container/fence parser may consume math |
| src/lib/emoji.ts | Emoji definition registry | MD-EXT-0 audit only | Preserve current plugin behavior |
| src/lib/frontmatter.ts | Frontmatter/body split and title handling | MD-EXT-6 only if source context must be carried | Do not change title semantics casually |
| src/lib/markdownHeadings.ts | New narrow heading metadata/TOC module, if MD-EXT-0 confirms this boundary | MD-EXT-1 | Owns final ID integration but not generic attrs |
| src/lib/fenceMeta.ts | Canonical fence-info parser and normalized FenceMeta | MD-EXT-3 | Discovery and renderer consume FenceMeta; source notation stays in Shiki |
| src/lib/markdownResources.ts | New client logical expansion/resource interface, if selected | MD-EXT-6 | Per-render state only |
| src/shiki.css | Reader palette, MD-EXT-3 annotation CSS, and MD-EXT-4 line-number CSS | MD-EXT-3 / MD-EXT-4 | CSS-only theme switching; no user-derived selectors |
| src/style.css | Article layout, callouts, reader/PDF shared styling | MD-EXT-1 / MD-EXT-2 as needed | Keep generic layout and theme boundaries |
| src/main.ts | Static stylesheet imports | MD-EXT-3 only if new CSS file is selected | No runtime theme retokenization |
| src/composables/vault/useMarkdownRender.ts | Async render lifecycle, stale-result cancellation, final HTML heading extraction | MD-EXT-1; source options at MD-EXT-6 | Keep stale renders from replacing newer content |
| src/components/vault/RenderedMarkdown.vue | v-html surface and post-render Mermaid/MarkMap/math mounts | MD-EXT-5 | Add code-group enhancement without Vue-compiling HTML |
| src/components/vault/ReadingPane.vue | Visible reader surface, scroll spy, published page-nav | MD-EXT-1 only if source/render options need forwarding | Existing page-nav reads final IDs |
| src/components/vault/PdfExportSurface.vue | Hidden printable render surface with light render-theme | MD-EXT-5/6 only for typed context forwarding | Must not mutate global data-theme |
| src/composables/useMermaidMount.ts | Mermaid widget mount/unmount lifecycle | MD-EXT-0 audit only | Exact placeholder/mount contract remains |
| src/composables/useMarkmapMount.ts | MarkMap widget mount/unmount lifecycle | MD-EXT-0 audit only | Exact placeholder/mount contract remains |
| src/composables/useMathMount.ts | KaTeX placeholder lifecycle | MD-EXT-0 audit only | Existing readiness contract remains |
| src/composables/useCodeGroupMount.ts | Root-scoped code-group tab interaction/cleanup | MD-EXT-5 | No global listener or persisted active state |
| src/lib/pdfExport.ts | Printable clone, CSS owner, widget staticization, pagination, settled local-image export boundary | MD-EXT-1 onward only for approved extension proof | PDF uses settled HTML; no resource reread or second local-image endpoint request |
| src/lib/pdf-readiness.ts | Mermaid/MarkMap/math terminal-state gate | MD-EXT-5 when code groups/images need extension hooks | Error states remain settled, not hangs |
| server/paths.ts | CONTENT_DIR, strict physical path resolver, symlink/race checks | MD-EXT-0 audit; MD-EXT-6 only for a narrow helper extension | Never weaken raw dot-segment rejection |
| server/index.ts | Auth boundary and route mounting | MD-EXT-6 | Resource route remains behind authBoundary |
| server/routes/posts.ts | Markdown-note-specific CRUD/read API | MD-EXT-0 audit only | Do not reuse it for arbitrary source resources |
| server/routes/vault.ts | Vault/tree and file-state API | MD-EXT-0 audit only | No generic file endpoint |
| server/markdownResources.ts / route equivalent | Future authenticated text/asset resource boundary | MD-EXT-6 | Canonical path only; generic errors |
| src/lib/__tests__/markdown.test.ts | Current Markdown integration and Shiki behavior | MD-EXT-1 onward | Preserve all current tests and add focused cases |
| src/lib/__tests__/shiki.test.ts | H8 runtime, transformer, lazy language, CSS ownership, and line-number structure | MD-EXT-3 / MD-EXT-4 | Add coverage without new runtime |
| src/lib/__tests__/wikiLinks.test.ts | WikiLink and .md link classification | MD-EXT-1/6 | Test renderer composition and context |
| src/lib/__tests__/callouts.test.ts | Existing callout contract | MD-EXT-2 | Regression file, not rewritten |
| src/composables/vault/__tests__/useMarkdownRender.test.ts | Final HTML heading extraction/page-nav contract | MD-EXT-1 | Continue consuming final IDs |
| src/lib/__tests__/pdfExport.test.ts | PDF HTML/CSS/staticization/pagination helpers | MD-EXT-1 onward | Add computed/style and all-panel proof |
| src/lib/__tests__/pdf-readiness.test.ts | Async widget readiness | MD-EXT-5/6 | Resource/image readiness must not hang |
| server/__tests__/paths.test.ts | Physical path safety | MD-EXT-6 | Reuse patterns; add logical/physical separation tests |
| server/__tests__/auth-middleware.test.ts | Protected API boundary | MD-EXT-6 | New route must require authenticated session |
| e2e/markdown-visual.spec.ts | Reader Markdown visual baseline | MD-EXT-1 onward | Add dedicated fixtures where possible |
| e2e/markdown-shiki-security.spec.ts | Sanitizer/Shiki CSS boundary | MD-EXT-3 | No style/event/data wildcard regression |
| e2e/markdown-shiki-theme.spec.ts | CSS-only Shiki theme behavior | MD-EXT-3 onward | No rerender/token identity changes |
| e2e/pdf-export-shiki.spec.ts | Printable-light token proof | MD-EXT-3 onward | Extend computed-color evidence |
| e2e/pdf-export*.spec.ts | PDF export/layout/pagination/stress/compatibility | MD-EXT-1 onward | Keep existing stress suites intact |

The paths with “route equivalent” are planning candidates, not files that already
exist. MD-EXT-0 must confirm final module placement before MD-EXT-6.

## 8. Compatibility and Scope Ownership

The PRD’s 43-row inventory remains the source-of-truth scope map. The following table
assigns every ADD or ADAPT feature to exactly one primary phase. EXISTING features are
protected by MD-EXT-0 audit and every later regression gate. DEFER and REJECT rows have
no implementation owner.

| # | Feature / syntax | PRD source/classification | Primary phase | Release treatment |
| ---: | --- | --- | --- | --- |
| 1 | Automatic heading anchors | Existing / EXISTING | MD-EXT-1 regression owner | Preserve |
| 2 | Custom heading anchors | VitePress / ADD | MD-EXT-1 | Ship |
| 3 | Internal links | VitePress + Existing Nuvyn / ADAPT | MD-EXT-1 | Preserve and test |
| 4 | Page suffix behavior | VitePress / REJECT | None | Reject |
| 5 | External links | VitePress / ADD | MD-EXT-1 | Ship for generated Markdown/linkify only |
| 6 | Frontmatter | Existing / EXISTING | MD-EXT-0 regression owner | Preserve |
| 7 | Tables | Existing / EXISTING | MD-EXT-0 regression owner | Preserve |
| 8 | Task lists | Existing / EXISTING | MD-EXT-0 regression owner | Preserve |
| 9 | Footnotes | Existing / EXISTING | MD-EXT-0 regression owner | Preserve |
| 10 | Emoji | Existing / EXISTING | MD-EXT-0 regression owner | Preserve |
| 11 | [[toc]] | VitePress / ADD | MD-EXT-1 | Ship |
| 12 | Built-in containers | VitePress / ADD | MD-EXT-2 | Ship |
| 13 | Container titles | VitePress / ADD | MD-EXT-2 | Ship |
| 14 | Custom container registration | VitePress / DEFER | None | Out of release scope |
| 15 | Nested containers | VitePress / ADD | MD-EXT-2 | Ship |
| 16 | Container additional attributes | Nuvyn narrow decision / REJECT except open token | MD-EXT-2 | No generic attrs |
| 17 | ::: raw | VitePress / REJECT | None | Reject |
| 18 | Existing callout alerts | Existing Nuvyn / EXISTING | MD-EXT-2 regression owner | Preserve |
| 19 | Shiki syntax highlighting | Existing H8 / EXISTING | MD-EXT-0 regression owner | Reuse |
| 20 | Fence line ranges | VitePress/Shiki / ADD | MD-EXT-3 | Ship |
| 21 | [!code highlight] | VitePress/Shiki / ADD | MD-EXT-3 | Ship, single-line form |
| 22 | [!code focus] | VitePress/Shiki / ADD | MD-EXT-3 | Ship |
| 23 | [!code ++]/[!code --] | VitePress/Shiki / ADD | MD-EXT-3 | Ship |
| 24 | warning/error | VitePress/Shiki / ADD | MD-EXT-3 | Ship |
| 25 | [!code info] | Shiki/Nuvyn extension / ADD | MD-EXT-3 | Ship as Nuvyn extension |
| 26 | Line numbers | VitePress / ADD | MD-EXT-4 | Ship opt-in |
| 27 | Custom line-number start | VitePress / ADD | MD-EXT-4 | Ship bounded |
| 28 | Code snippet imports | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship only through safe resource boundary |
| 29 | Snippet regions | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship controlled subset |
| 30 | Snippet ranges | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship bounded |
| 31 | Explicit snippet language | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship safe token |
| 32 | Code groups | VitePress / ADD | MD-EXT-5 | Ship |
| 33 | Snippets inside code groups | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Reuse resolver; no duplicate read |
| 34 | Markdown includes | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship approved core |
| 35 | Nested Markdown includes | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship with depth/cycle limits |
| 36 | Include ranges | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship bounded |
| 37 | Heading/section includes | VitePress/Nuvyn candidate / DEFER | None | Not a release blocker |
| 38 | Included relative URL/image rebasing | VitePress/Nuvyn / ADAPT | MD-EXT-6 | Ship through source context and asset policy |
| 39 | Code-file inclusion inside fence | VitePress/Nuvyn candidate / DEFER | None | Not a release blocker |
| 40 | Math | Existing Nuvyn / EXISTING | MD-EXT-0 regression owner | Preserve |
| 41 | Lazy images | VitePress / ADD | MD-EXT-1 | Generated Markdown images only |
| 42 | Advanced Markdown configuration | VitePress/Nuvyn / ADAPT | MD-EXT-0 contract owner | Typed Nuvyn options only |
| 43 | VitePress runtime/build compatibility | VitePress / REJECT | None | Reject |

The following remain explicitly deferred or rejected:

| Feature | Status |
| --- | --- |
| [!code highlight:N] | DEFERRED; do not implement opportunistically |
| Heading/section include | DEFERRED |
| Code-file inclusion inside fences | DEFERRED |
| Arbitrary custom container registration | DEFERRED |
| Generic attributes | REJECTED |
| ::: raw sanitizer bypass | REJECTED |
| VitePress routing/page suffixes | REJECTED |
| Vue-in-Markdown | REJECTED |
| Remote resources | REJECTED |

## 9. Security Invariants

| Threat | Frozen invariant | Owning phase/tests |
| --- | --- | --- |
| Markdown style injection | FORBID_ATTR: ['style'] remains unchanged | MD-EXT-1 through MD-EXT-7; markdown sanitizer tests |
| Event attributes | onclick/on* are removed; generated HTML never emits them | MD-EXT-1/2/5 security tests |
| Script/style/embedded execution | Forbidden tags remain forbidden | All phases; markmap/security regressions |
| Dangerous URI | Existing DOMPurify URI policy remains | MD-EXT-1/6; Markdown and E2E security |
| Generic attrs | No global attrs parser; only feature-specific grammar | MD-EXT-1/2/5 |
| Arbitrary data-* | Keep the four-attribute Nuvyn hook; additions are exact and reviewed | MD-EXT-5 only if unavoidable |
| Source-derived CSS | Labels, IDs, languages, and paths never become arbitrary selectors or CSS | MD-EXT-2/3/4/5/6 |
| Shiki style bypass | Only trusted bundled transformer CSS is generated outside article HTML | MD-EXT-3 |
| Second Shiki runtime | Existing singleton remains the only highlighter | MD-EXT-3/7 bundle audit |
| Wiki resolver double call | Discovery env never receives caller resolver; resource expansion does not duplicate final calls | MD-EXT-0/1/6 |
| Path traversal | Logical normalization may consume dot segments, but canonical path cannot contain them | MD-EXT-6 |
| Physical root escape | readSafeRelativeFile receives only canonical root-relative path | MD-EXT-6 server tests |
| Symlink/junction escape | lstat identity and no-follow/revalidation contract remains | MD-EXT-6 |
| SSRF/remote read | Protocol URLs, file URLs, absolute paths, and remote resources are rejected | MD-EXT-6 |
| Binary/encoding abuse | Allowlisted UTF-8 text only for expansion; invalid/binary input returns generic error | MD-EXT-6 |
| Include cycles/amplification | Canonical stack, depth 8, file/final byte limits | MD-EXT-6 |
| Error disclosure | User sees safe generic error; host path/stack remains server-only | MD-EXT-6 |
| PDF theme leakage | PDF consumes printable-light token variables irrespective of reader theme | MD-EXT-3/4/5/7 |
| Active tab leakage | PDF clone exposes all code-group panels | MD-EXT-5/7 |
| Vue execution | Markdown HTML is never compiled as a Vue template | MD-EXT-5 |
| Stale async result | New source cancels/ignores old resource render | MD-EXT-6 |

## 10. Sanitizer Delta Ledger

The current sanitizer has already been audited. The plan intentionally starts with
the smallest exact deltas:

| Feature / phase | Generated tag/attribute | Current sanitizer status | Proposed delta | Security rationale |
| --- | --- | --- | --- | --- |
| Custom anchors / MD-EXT-1 | h1-h6 id and permalink href | id/href already allowed | None | IDs are generated by the final allocator, not generic attrs |
| TOC / MD-EXT-1 | nav, aria-label, role, a, href, ul/li | role/a/href/ul/li allowed; nav and aria-label absent | Add nav and aria-label only after explicit review | Semantic static navigation; no user-controlled tag/class |
| Lazy images / MD-EXT-1 | img loading | loading already allowed | None | Adds browser hint only; URL policy unchanged |
| Containers / MD-EXT-2 | div/details/summary/class | tags/class already allowed | Add open only if MD-EXT-0 approves narrow details {open} | Boolean feature token, not generic attrs |
| Annotations / MD-EXT-3 | class on trusted Shiki elements | class already allowed | None | Classes come from fixed transformer mapping |
| Line numbers / MD-EXT-4 | span aria-hidden class | span/aria-hidden/class already allowed | None | Trusted structural gutter, no inline style |
| Code groups / MD-EXT-5 | button, tab ARIA, tabindex | button and aria-selected/controls/labelledby/tabindex may be absent | Add button, aria-selected, aria-controls, aria-labelledby, tabindex only | Narrow accessible static tabs; no onclick, style, wildcard data |
| Resources / MD-EXT-6 | safe placeholders/classes | div/class/role existing | Prefer no new article data-* | Resource errors are static escaped text |

The code-group plan deliberately avoids a generic data-group/data-index attribute.
Generated tab/panel identity uses safe per-render ids plus aria-controls and DOM
structure. If MD-EXT-0 discovers that a required ARIA attribute differs from this
ledger, it records the exact narrow addition before MD-EXT-5.

No phase may remove style from FORBID_ATTR, permit raw style, enable wildcard aria,
or use sanitizer configuration as a substitute for safe parser design.

## 11. State and Concurrency Model

| State | Lifetime/owner | Rules |
| --- | --- | --- |
| MarkdownIt instance | Module singleton | Immutable plugin/rule registration after initialization |
| Shiki highlighter | Module singleton | Reuse H8 runtime and its retry/lazy loading |
| transformerStyleToClass | Module singleton | One class registry and one stylesheet owner |
| Bundled language registry | Module immutable data | No user language-to-loader mapping |
| Render env | One render | WikiResolver, source context, heading records, fence metadata |
| Heading collision registry | One render | Never module-global; includes every final heading in source order |
| TOC records | One render | Derived from final heading tokens, not HTML parsing |
| FenceMeta | One render/code block | Derived only from the fence info string; reused by discovery, rendering, meta ranges, line numbers, labels, and special-fence classification |
| Shiki source notation | One codeToHtml invocation/code source | `[!code ...]` is consumed by approved notation transformers; no module-global notation state |
| Resource cache | One resource expansion request | Keyed by canonical path + kind/selection; no cross-user global cache |
| Include stack | One expansion request | Canonical logical paths; detects A → B → A cycles |
| Code-group id sequence | One render scope | Deterministic counter with internal surface prefix; never derived from label |
| Code-group active tab | One rendered article DOM root | Event delegation and cleanup scoped to that root |
| Mermaid/MarkMap/math apps | One rendered surface | Existing mount composables own lifecycle |
| PDF clone | One export transaction | Uses already-rendered HTML and printable stylesheet |
| Current source path | Explicit render context | Never stored in module-global mutable state |

useMarkdownRender already marks old async renders cancelled when the source changes.
MD-EXT-6 passes an AbortSignal when the resource boundary supports it and still
checks the existing cancelled flag before publishing HTML/headings. A completed old
render may be discarded; it must never replace the newer document.

## 12. Final Heading-ID Architecture

### 12.1 Selected implementation shape

Use one focused Nuvyn module, recommended name
src/lib/markdownHeadings.ts, for custom heading metadata and TOC registration.
Do not create a generic Markdown extension framework.

The module registers three narrow pieces around the existing
markdown-it-anchor@9.2.0 rule:

1. a heading metadata core rule inserted after inline parsing but before the named
   anchor rule;
2. the existing anchor plugin configured with Nuvyn slugification and a
   slugifyWithState adapter;
3. a final heading/TOC core rule after anchor allocation.

The installed markdown-it-anchor 9.2.0 exposes:

- a core rule named anchor;
- slugifyWithState(str, state);
- a permalink callback receiving the final slug;
- a uniqueness allocator that suffixes later generated IDs.

The selected markdown-it-anchor configuration conceptually includes:

~~~ts
.use(anchor, {
  slugifyWithState: ...,
  uniqueSlugStartIndex: 2,
  permalink: ...
})
~~~

`uniqueSlugStartIndex: 2` is a frozen Nuvyn product/implementation parameter. It
produces `id`, `id-2`, `id-3` for later collisions; changing it requires PRD review.
MD-EXT-0 must capture the installed rule order and verify that the installed
markdown-it-anchor@9.2.0 behavior can honor this explicit option. The selected design
does not rely on undocumented array positions.

### 12.2 Custom anchor flow

The pre-anchor rule walks heading_open plus its following inline token. It recognizes
only a final plain-text suffix matching the PRD’s narrow {#id} grammar. When valid it:

- removes only that suffix from the inline children, so visible heading text is clean;
- records either null or the explicit id in a per-render ordered queue in env;
- leaves malformed suffixes as visible ordinary heading text;
- never copies arbitrary author text into an HTML attribute.

slugifyWithState consumes that queue in the same heading order. It returns the
explicit safe id for a custom heading and the existing Nuvyn slug for an automatic
heading. markdown-it-anchor, configured with uniqueSlugStartIndex: 2, then applies
one uniqueness allocator to both forms.

The required collision contract is:

~~~markdown
## Hello
## Hello
## Hello
~~~

~~~text
hello
hello-2
hello-3
~~~

~~~markdown
## Hello
## Other {#hello}
~~~

~~~text
hello
hello-2
~~~

~~~markdown
## First {#hello}
## Hello
~~~

~~~text
hello
hello-2
~~~

~~~markdown
## First {#x}
## Second {#x}
~~~

~~~text
x
x-2
~~~

~~~markdown
## Hello
## Other {#hello}
## Hello
~~~

~~~text
hello
hello-2
hello-3
~~~

Future included headings participate in the same source-order sequence. The
collision registry remains per render, so concurrent renders cannot share allocation
state. Only the narrow final `{#safe-id}` suffix is supported; generic attributes such
as `{.class}`, `{style="..."}`, or `{onclick="..."}` remain out of scope.

The allocator lives in the render’s MarkdownIt state/env. It is reset on every
render, so concurrent renders cannot share collision state.

Because markdown-it-anchor receives the final slug, its permalink href is correct
without a second patching pass. Reader page-nav and PDF internal links consume the
same final id from rendered heading tokens/HTML.

### 12.3 TOC flow

The block parser recognizes exactly a standalone, case-sensitive [[toc]] block.
It does not recognize inline text, code spans, fenced content, or [[TOC]].

The block rule emits a private nuvyn_toc token. The final core rule runs after
markdown-it-anchor, walks the final heading tokens, filters h2-h4, and stores:

~~~text
{ level, id, safeText }
~~~

It then renders the private token to a static semantic nav/list fragment. The chosen
sanitizer-compatible output is:

~~~html
<nav class="nuvyn-toc" role="navigation" aria-label="Table of contents">
  <ul>
    <li class="nuvyn-toc-level-2"><a href="#final-id">Readable title</a></li>
  </ul>
</nav>
~~~

The nav/aria-label additions are the only planned TOC sanitizer delta. Heading text
comes from token children, not raw HTML. Text and code_inline content are collected;
unsafe inline HTML is reduced to readable text and the final DOM still passes
DOMPurify. Nested list structure follows heading level with deterministic
intermediate handling for skipped levels.

TOC generation does not invoke WikiResolver, render another Markdown document, or
slugify text. The existing useMarkdownRender final-HTML extraction may continue to
serve the reader RightRail; that path reads IDs already allocated by the same
pipeline. [[toc]] itself never parses rendered HTML to invent IDs.

### 12.4 Heading tests and stop conditions

Required tests include automatic/custom/duplicate IDs, all five collision examples
above, the exact id/id-2/id-3 suffix contract, malformed suffixes, inline formatting,
CJK automatic slugs, TOC standalone recognition, TOC hierarchy, safe heading text, no
resolver calls from TOC collection, PDF internal links, and included-heading
participation after MD-EXT-6. MD-EXT-0 records core rule name, slugifyWithState,
uniqueSlugStartIndex, permalink callback behavior, duplicate allocation, and actual
rule ordering; it verifies the installed behavior without casually reopening the
approved suffix convention.

STOP if the installed markdown-it-anchor integration cannot provide one shared
per-render allocator with the approved id/id-2/id-3 contract without a second slugger
or a generic-attributes mechanism.

STOP if custom anchors require generic attributes, TOC requires a second slugger, or
permalink hrefs cannot be derived from the one final allocator.

## 13. Fence-Info Metadata and Shiki Source-Notation Architecture

### 13.1 Two independent metadata channels

Fence metadata and Shiki source-code notation are different input streams and must
remain different implementation boundaries.

Fence info is the string after the opening fence marker:

~~~~markdown
~~~ts {1,3-5}:line-numbers [config.ts]
~~~
~~~~

Code-body notation is part of the source between the fence markers:

~~~ts
const a = 1 // [!code focus]
const b = 2 // [!code error]
~~~

`parseFenceMeta(info)` receives only the first stream. It never receives or parses
`[!code ...]` directives from the second stream. The architecture is one fence-info
parser plus one approved Shiki source-notation transformer pipeline, not one parser
for every code annotation syntax.

### 13.2 Fence-info parser

Create a narrow module, recommended name src/lib/fenceMeta.ts, after MD-EXT-0
confirms the boundary. Its `parseFenceMeta(info)` contract parses only the fence info
string and returns block-level metadata used by:

- final fence-language discovery;
- normal fence rendering;
- the Shiki meta range mechanism;
- line-number metadata;
- code-group display labels;
- later snippet explicit-language selection;
- exact Mermaid/MarkMap special-fence classification.

The conceptual representation is:

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

There is deliberately no `notation` field. Exact property names may change, but
`FenceMeta` must not contain parsed `highlight`, `focus`, `diff`, `warning`, `error`,
or `info` source-notation state.

The fence-info parser rules are:

- the first language identifier is independent from later metadata;
- `ts {1,3-5}`, `ts:line-numbers`, `ts:line-numbers=10`, and `ts [config.ts]` all
  prepare TypeScript rather than treating metadata as part of the language;
- `{1,3-5}` belongs to `highlightRanges` and is consumed by the approved Shiki meta
  range mechanism;
- `:line-numbers=N` is validated and bounded here, because it belongs to fence info;
- labels are safe display metadata and never become CSS selectors or arbitrary ids;
- unknown/malformed fence metadata never throws and does not alter special-fence
  behavior;
- known special fences are recognized only when the language identifier is exactly
  `markmap` or `mermaid`; `mermaid{1}` and `markmap{1}` are not special fences;
- `[!code highlight]`, `[!code focus]`, `[!code focus:N]`, `[!code ++]`,
  `[!code --]`, `[!code warning]`, `[!code error]`, and `[!code info]` are not
  parsed here, because they are code-source notation;
- `highlight:N` is not parsed or activated here. Its deferred boundary belongs to
  source-notation handling.

### 13.3 Source-code notation transformer pipeline

The code source is passed to Shiki independently of `parseFenceMeta(info)`:

~~~text
code source
    ↓
codeToHtml(source, ...)
    ↓
approved source-notation transformers
    ↓
fixed structural annotation classes
~~~

The approved source-notation pipeline conceptually handles:

- `transformerNotationHighlight` or a deliberately restricted single-line adapter
  for `[!code highlight]`;
- `transformerNotationFocus` for `[!code focus]` and approved `[!code focus:N]`;
- `transformerNotationDiff` for `[!code ++]` and `[!code --]`;
- `transformerNotationErrorLevel` for `[!code warning]`, `[!code error]`, and
  `[!code info]`;
- the existing `transformerStyleToClass` instance last, as the sole token-style-to-
  class registry and generated-CSS owner.

The `{1,3-5}` fence-info range and `[!code highlight]` source notation are separate
mechanisms even when they produce related visual classes. `transformerMetaHighlight`
or the verified equivalent consumes the former; `transformerNotationHighlight` or a
restricted adapter consumes the latter.

`focus:N` is validated and bounded at the source-notation/approved-transformer
boundary, not in `parseFenceMeta(info)`. If the installed Shiki transformer accepts
`[!code highlight:N]` while the PRD keeps it deferred, MD-EXT-3 must block it at this
same source-notation boundary. It must not pretend the syntax arrived in fence info.
The current plan therefore does not activate range highlight notation merely because
Shiki 4.4.3 can technically recognize it.

MD-EXT-0 records the actual installed @shikijs/transformers 4.4.3 API and hook
lifecycle. The notation factories may be reused only if evidence proves they are
safe; the highlighter and `transformerStyleToClass` remain the one long-lived
singleton/style owner. Only a narrowly reviewed source-notation gating helper may be
added later if the installed API requires one; it must not become a second Shiki
runtime, CSS registry, or FenceMeta notation object.

### 13.4 Consumers and tests

`FenceMeta` is consumed by fence-language discovery, normal fence rendering, meta
range highlighting, line-number behavior, code-group display labels, exact
special-fence classification, and future snippet explicit-language handling. It is
derived only from the info string and is per fenced block/render.

The source-notation pipeline is consumed by each `codeToHtml` invocation and reads
the code source. It owns highlight/focus/diff/severity notation and has no
module-global mutable notation state.

MD-EXT-0 must verify that language discovery still treats `ts {1,3}`,
`ts:line-numbers`, and `ts [config.ts]` as TypeScript, while only bare `mermaid` and
`markmap` bypass normal Shiki handling.

## 14. Resource Resolution Architecture

### 14.1 Two-stage path model

MD-EXT-6 uses exactly:

~~~text
author reference
    ↓
logical source-relative resolver
    ↓
canonical vault-relative logical path
    ↓
authenticated physical safe resolver
    ↓
bounded read
~~~

Examples:

~~~text
source:    guides/java/index.md
reference: ../shared/demo.ts
logical:   guides/shared/demo.ts
physical:  guides/shared/demo.ts
result:    allowed
~~~

The logical layer may consume ./ and ../. It rejects empty, absolute Unix/Windows,
UNC, drive-letter, backslash, NUL/control, protocol/URI, and root-escaping forms.
The canonical result has POSIX separators and no . or .. segments. The physical
resolver receives only that canonical result.

The existing server/paths.ts helpers intentionally reject dot segments and backslashes.
The plan does not weaken them. The final server read uses
resolveSafeRelativePathDetailed() and readSafeRelativeFile(), including the existing
lstat identity/no-follow/revalidation behavior.

### 14.2 Client/server resource boundary

The plan recommends:

~~~text
server/markdownResources.ts
server/routes/markdownResources.ts
src/lib/markdownResources.ts
~~~

The exact filenames are confirmed in MD-EXT-0. The server route is narrow, authenticated
by the existing app.use('/api/*', authBoundary), and accepts a canonical relative path
plus an explicit resource kind. It never accepts an absolute path or raw author
reference and never exposes an absolute path in a response.

Text reads:

- snippet kind: allowlisted source/text file, maximum 256 KiB before decode;
- include kind: Markdown text only, maximum 512 KiB before decode;
- response: bytes decoded with fatal UTF-8, never lossy Buffer.toString fallback;
- invalid UTF-8, binary-looking/unsupported type, directory, symlink, missing, or
  oversized input returns a generic safe error.

The planning recommendation for the extension policy is an explicit allowlist:

~~~text
Markdown include: .md
Source/text snippets: .ts .tsx .js .jsx .mjs .cjs .vue .css .scss .less
.html .xml .json .yaml .yml .toml .sql .py .java .go .rs .rb .php
.sh .bash .zsh .fish .c .h .cc .cpp .hh .hpp .cs .kt .kts .swift
.dart .lua .r .txt
~~~

Extensionless files and unlisted extensions are rejected in the initial core. MD-EXT-0
must confirm this recommendation as the implementation parameter; it may not silently
broaden it during coding. The allowlist is a content policy, not a path-security
replacement.

Relative images in included Markdown are a separate asset concern: they are not
decoded as text. If the current app has no suitable asset route, MD-EXT-6 adds a
narrow authenticated image-asset response using an exact image extension/MIME
allowlist and the same canonical physical resolver. SVG is excluded initially unless
an independent sanitizer/MIME review approves it. This route is not a generic file
download endpoint.

The post API is not reused for non-Markdown resources. A route such as
/api/posts/foo.ts is not a valid resource design.

### 14.3 Render options and expansion order

The existing caller-compatible API is extended only when MD-EXT-6 is ready:

~~~ts
render(markdown, {
  resolver,
  sourcePath,
  resourceResolver,
  signal,
  renderScope,
})
~~~

sourcePath accepts the existing Nuvyn document identity used by activeTab.path
(extensionless); the resource layer normalizes it to a .md source identity for
relative-directory calculation. Existing callers can omit all resource options and
retain current behavior.

The order is frozen:

~~~text
parse frontmatter/body
    ↓
expand snippet/include directives outside code spans/fences
    ↓
canonicalize or safely mark included link/image/WikiLink context
    ↓
enforce per-file/depth/final-size limits
    ↓
discover final fence tokens
    ↓
prepare final Shiki languages
    ↓
MarkdownIt render
    ↓
sanitize
~~~

No resource read occurs inside a synchronous MarkdownIt fence renderer.

### 14.4 Preserving included source context

Simple string concatenation is not sufficient. The selected plan uses a per-render
source-aware expansion representation:

~~~text
ExpandedSegment {
  text
  sourcePath
  sourceKind: root | include
  sourceLineStart
}
~~~

The expander processes each segment with a fence/code-span-aware reference rewriter
before flattening the final source. Standard internal Markdown links and asset
destinations are rewritten to canonical Nuvyn targets/asset URLs. WikiLinks and any
resolver-backed internal destination use an opaque per-render context marker that is
recognized only by the Nuvyn WikiLink/link classifier, stripped before output, and
calls the resolver with the included source path.

The backward-compatible resolver shape becomes conceptually:

~~~ts
type Resolver = (
  ref: string,
  anchor?: string,
  context?: { sourcePath?: string },
) => ResolvedWikiLink
~~~

Existing two-argument resolvers continue to work. VaultView’s normal resolver uses
activePath for ordinary content and context.sourcePath for included content; the PDF
resolver uses the export target path. No module-global current source is introduced.

The opaque marker is generated by the render context, is not a public author syntax,
does not use user labels, and is ignored if it is not present in the current render
table. This prevents author input from forging context. Tests must prove that each
real final link resolves once and that included bare WikiLinks use the included
source directory.

### 14.5 Limits, regions, cycles, and errors

Adopt the PRD recommendations unless MD-EXT-0 records a reviewed alternative:

| Limit | Value | Enforcement point |
| --- | ---: | --- |
| Extracted snippet | 256 KiB | Before decode/Shiki |
| Included file | 512 KiB | Server read before decode |
| Final expanded Markdown | 2 MiB | During expansion before final parse |
| Include depth | 8 | Before recursive read |
| Focus:N | 1000 recommended bound | Source-notation validation/approved transformer boundary |
| line-numbers=N | 100000 recommended bound | Fence metadata parser |

Basic named regions use a documented marker grammar, matching start/end names,
strip marker lines, concatenate repeated matching regions in source order, and reject
unclosed/mismatched nesting. Line ranges are positive one-based inclusive ranges,
bounded by the source file and output limit. Missing region/range produces a local
safe placeholder rather than a document-wide exception.

Cycle detection uses canonical logical path stack identity:

~~~text
A.md → ./b.md → ../a.md
guides/a.md → guides/b.md → guides/a.md
~~~

Duplicate non-cyclic includes are allowed and may use a per-render canonical read
cache. The cache key includes canonical path and selection/kind. It is discarded at
the end of the render.

Visible errors are generic, escaped, and local. They never contain an absolute host
path, stack trace, raw server message, or HTML. Internal errors retain classification
for tests/logging without exposing it to the article.

### 14.6 MD-EXT-6 stop conditions

STOP if:

- the endpoint cannot prove authentication and vault-root confinement;
- implementation requires passing raw dot segments to server/paths.ts;
- source context needs a module-global current document path;
- expansion causes duplicate WikiResolver side effects that cannot be bounded;
- the final source cannot be discovered before Shiki preparation;
- resource work requires remote URLs or browser filesystem access;
- binary/invalid text is decoded lossily;
- PDF must reread paths to export the rendered document.

## 15. Reader Interaction Architecture

### 15.1 Current surface

RenderedMarkdown.vue owns a sanitized article root and three post-render mount
composables. ReadingPane owns scroll-spy/page-nav publication. RightRail renders the
page-nav list and active state. This lifecycle is the integration point for code groups;
Markdown HTML itself is never compiled by Vue.

### 15.2 Code-group enhancement

MD-EXT-5 adds a Nuvyn-owned useCodeGroupMount.ts or equivalent only after inspecting
the existing mount lifecycle. It:

- scans one article root for static nuvyn-code-group markup;
- initializes active tab from generated aria-selected/class state;
- uses event delegation within that root;
- supports click, Enter/Space, ArrowLeft/ArrowRight, Home/End;
- updates only that group’s buttons/panels;
- uses no inline handlers, Vue directives, or HTML template compilation;
- observes v-html replacement and tears down old listeners/apps;
- does not retrigger Markdown rendering or Shiki tokenization;
- keeps each surface’s active state independent.

Generated ids are per-render deterministic sequences with an internal render-scope
prefix. Labels never become raw ids. A component-local scope separates the visible
reader from a simultaneously mounted PDF surface.

### 15.3 Static code-group DOM contract

The planned structure is:

~~~html
<div class="nuvyn-code-group" role="group" aria-label="Code examples">
  <div class="nuvyn-code-group-tabs" role="tablist">
    <button type="button" role="tab" id="nuvyn-cg-...-tab-0"
      aria-controls="nuvyn-cg-...-panel-0" aria-selected="true" tabindex="0">
      JavaScript
    </button>
  </div>
  <div class="nuvyn-code-group-panels">
    <div id="nuvyn-cg-...-panel-0" class="nuvyn-code-group-panel is-active"
      role="tabpanel" aria-labelledby="nuvyn-cg-...-tab-0" aria-hidden="false">
      <pre>...</pre>
    </div>
  </div>
</div>
~~~

All panels remain in sanitized DOM. Inactive panels use aria-hidden and a class/CSS
state, not a Vue conditional. PDF preparation overrides the reader active state and
exposes every panel with its label in source order.

### 15.4 Theme and lifecycle

Code-group interaction is behavior-only and does not change syntax tokens. The
existing CSS-only theme contract applies to all panels, including hidden reader
panels and PDF clones. Re-render, route change, unmount, and concurrent reader/PDF
surfaces must not leak listeners or state.

## 16. PDF Integration Architecture

### 16.1 Existing boundary

PdfExportSurface.vue renders a separate hidden article with render-theme="light".
VaultView passes a target-specific raw source and PDF WikiResolver. The current PDF
flow waits for Mermaid/MarkMap/math, calls preparePdfArticleHtml(), injects a trusted
PDF stylesheet owner, and hands the clone to html2pdf.js.

The plan extends this boundary; it does not create a second render pipeline.

### 16.2 Extension behavior

| Feature | Reader | PDF |
| --- | --- | --- |
| Custom anchors | Final ids and permalink | Same ids and internal hrefs |
| [[toc]] | Static nav/list | Static printable nav/list; links point to same ids |
| External links | Generated target/rel | Printable href/text; no reader interaction required |
| Lazy images | Generated Markdown loading hint | Existing readiness/clone flow still includes images |
| Containers | Reader light/dark styles | Printable light block/details styles; details opened if approved |
| Annotations | CSS classes and theme selectors | Printable-light class semantics and computed token proof |
| Line numbers | Gutter structural spans | Gutter retained, wrapped, printable, aria-hidden semantics preserved |
| Code groups | One active panel | Every labeled panel, stable source order |
| Includes/snippets | Already-expanded HTML | No new resource reads; clone settled HTML |
| Mermaid/MarkMap/math | Existing mount lifecycle | Existing staticization/readiness |

PDF selectors remain in src/lib/pdfExport.ts / its trusted stylesheet owner and may
override reader selectors under .pdf-document. They must not rely on the active
reader tab, root data-theme, or a second Shiki tokenization.

### 16.3 PDF gates

Every phase that changes article HTML must add or update focused PDF proof:

- custom ids and TOC links are present and point to existing anchors;
- details/containers remain readable and do not swallow pagination;
- annotation classes produce the intended printable result;
- line-number gutters wrap and do not clip;
- all code-group panels export after the reader selects a non-first tab;
- included/snippet content is already in articleHtml;
- image readiness still settles;
- existing Mermaid, MarkMap, math, long-line, oversized-block, pagination, and stress
  suites remain green.

The computed-style gate must inspect actual Shiki token colors where applicable, not
only pre/code existence or background color.

## 17. Dependency Strategy

The default plan adds no dependency:

- MarkdownIt core/block/inline rules are sufficient for narrow feature syntax;
- markdown-it-anchor@9.2.0 is already installed;
- @shikijs/transformers@4.4.3 is already installed;
- DOMPurify, Vue, and existing mount patterns cover current surfaces;
- line numbers use a Nuvyn-owned HAST/structural transform;
- code groups use Nuvyn DOM enhancement, not a tab framework;
- resource reads reuse server/paths.ts primitives.

For custom containers, the recommendation is a Nuvyn-owned narrow parser rather than
markdown-it-container. The required built-in set is small, the project needs exact
nesting/title/malformed behavior, and avoiding a dependency avoids an additional
parser’s bundle and sanitizer surface. MD-EXT-0 still records a maintenance/bundle
comparison against maintained markdown-it 14-compatible candidates; it must stop for
review if the narrow parser cannot handle the required nesting safely.

Forbidden dependencies:

- vitepress;
- @vitepress/*;
- VitePress runtime/theme packages;
- MDX;
- generic attrs plugins;
- a second Shiki Markdown integration.

Any exception must state reason, maintenance status, bundle/runtime impact, security
surface, and why existing code cannot reasonably handle the need.

## 18. Phase Dependency Graph

~~~text
MD-EXT-0 — Baseline & Compatibility Contract Audit
    ↓
MD-EXT-1 — Anchors, TOC, Links & Lazy Images
    ↓
MD-EXT-2 — Custom Containers
    ↓
MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata
    ↓
MD-EXT-4 — Line Numbers
    ↓
MD-EXT-5 — Code Groups
    ↓
MD-EXT-6 — Safe Snippets & Markdown Includes
    ↓
MD-EXT-7 — Full Regression, Bundle Audit & Release Gate
~~~

Semantic dependencies:

- MD-EXT-1 creates the final heading-ID contract that future included headings and
  TOC entries consume.
- MD-EXT-2 establishes deterministic colon-container parsing; MD-EXT-5 may reuse its
  container token model for code-group syntax.
- MD-EXT-3 owns the unified fence-info model and the separate Shiki source-notation
  transformer ordering.
- MD-EXT-4 consumes the existing FenceMeta line-number fields but must not
  duplicate the parser or absorb source notation.
- MD-EXT-5 consumes fence labels and the final static code-rendering contract.
- MD-EXT-6 happens after heading/fence contracts because expansion affects headings,
  links, source context, and final Shiki discovery.
- MD-EXT-7 is verification only; it is not a place to hide a substantial feature fix.

## 19. MD-EXT-0 — Baseline & Compatibility Contract Audit

Status: COMPLETE. Evidence: [MD-EXT-0 Baseline & Compatibility Contract Audit](vitepress-markdown-extensions-md-ext-0-audit.md). The audit recorded the exact
implementation baseline, current runtime/ruler contracts, installed API behavior,
sanitizer delta ledger, resource boundary, bundle baseline, and test limitations.

### Goal

Create durable evidence of the real post-H8 Nuvyn architecture and close all
implementation parameters that later phases must not rediscover.

### Prerequisites

- Approved PRD at 7e05e3bb43f4283a90ead1abd0c81325bc93281c is present.
- This Implementation Plan is the approved planning input.
- Shiki H0-H8 is closed.
- Working tree was clean and the exact MD-EXT implementation baseline is recorded
  as 582e312a4c5752a4c9a5c6bba7b0e752b0b78078.

### In scope

- Record git, Node/npm, package, lockfile, build, test, and bundle baseline.
- Inventory current Markdown plugin/rule order and output contracts.
- Inspect markdown-it-anchor@9.2.0 internals/API and prove the heading integration,
  including `uniqueSlugStartIndex: 2` and the id/id-2/id-3 allocation contract.
- Inspect @shikijs/transformers@4.4.3 actual source/types/hook lifecycle.
- Confirm sanitizer tags/attrs/data policy and PDF style/readiness behavior.
- Inspect reader post-render mount lifecycle and current page-nav extraction.
- Inspect server auth, posts route, server/paths.ts, and resource gap.
- Decide the exact sanitizer delta ledger, container mechanism, fence metadata shape,
  focus/line-number bounds, resource extension policy, and future file ownership.
- Create docs/design/vitepress-markdown-extensions-md-ext-0-audit.md.

### Explicitly out of scope

- Any production source or test modification.
- Any dependency/lockfile change.
- Any Markdown behavior change.
- Any server route.
- Any PRD rewrite.
- Any MD-EXT feature implementation.

### Architecture changes

None. This phase is evidence-only. It may produce a reviewed decision record for
the narrow Nuvyn-owned modules named in this plan, but it does not implement them.

### Likely production files

None. Read-only inspection targets include src/lib/markdown.ts, shiki.ts, wikiLinks.ts,
callouts.ts, math.ts, frontmatter.ts, useMarkdownRender.ts, RenderedMarkdown.vue,
PdfExportSurface.vue, pdfExport.ts, pdf-readiness.ts, mount composables, server/index.ts,
server/paths.ts, server/routes/posts.ts, and relevant tests.

### Likely tests/E2E

No new tests. Run existing focused baseline tests where practical:

- src/lib/__tests__/markdown.test.ts;
- src/lib/__tests__/shiki.test.ts;
- src/lib/__tests__/wikiLinks.test.ts;
- src/lib/__tests__/callouts.test.ts;
- src/composables/vault/__tests__/useMarkdownRender.test.ts;
- src/lib/__tests__/pdfExport.test.ts and pdf-readiness.test.ts;
- existing Markdown/Shiki/PDF Playwright specs if the browser environment is available.

### Dependency changes

None. MD-EXT-0 records package.json/package-lock.json versions and confirms no
VitePress/MDX/generic attrs package is present.

### Sanitizer changes

None. The evidence document records current allowed tags/attrs and the exact future
delta ledger; it does not apply the delta.

### Theme impact

None. Capture current system/forced theme behavior and Shiki CSS-only invariants.

### PDF impact

None. Capture current printable-light token, image, widget, pagination, and cleanup
evidence without replacing historical results.

### Security risks

The primary risk is planning from a hypothetical architecture. MD-EXT-0 must identify
any discrepancy between PRD and code and stop for PRD review if it changes semantics.

### Concurrency/state risks

Record the existing singleton/per-render/per-surface state and verify no current
resolver preflight double-call exists. Record the current stale-render cancellation
behavior as a constraint for MD-EXT-6.

### Manual acceptance

Reviewers must be able to answer:

- which current code produces normal fences, special fences, sanitized HTML, page-nav,
  and PDF;
- where the one Shiki runtime/CSS owner lives;
- which exact installed APIs the plan relies on;
- what current failures are pre-existing;
- what exact files each later phase is allowed to touch.

### Validation commands

~~~
git status --short
git rev-parse HEAD
git log -5 --oneline
node --version
npm --version
npm run typecheck
npm run test:unit
npm run build
~~~

Capture actual exit codes and failures honestly. MD-EXT-0 also records the Vite
production assets, raw/gzip sizes where available, warnings, and the baseline bundle
manifest. E2E commands use only scripts that exist in package.json and are marked
unavailable when browser dependencies/environment are absent.

### Rollback boundary

No application change exists to roll back. Delete/revert only the evidence document
if the audit is rejected; do not alter the production baseline.

### Exit criteria

- Actual baseline SHA and environment recorded.
- Current Markdown/Shiki/WikiLink/sanitizer/theme/PDF/mount/server architecture mapped.
- markdown-it-anchor hook/rule order recorded.
- Shiki 4.4.3 transformer order/lifecycle recorded.
- Exact sanitizer additions, if any, are listed.
- Container parser recommendation is selected.
- Fence metadata representation and numeric bounds are selected.
- Resource endpoint, extension policy recommendation, limits, and context approach are
  selected for later review.
- Bundle/test/build baseline is captured.
- No implementation or dependency change occurred.

### Evidence required

docs/design/vitepress-markdown-extensions-md-ext-0-audit.md with:

- audit SHA versus implementation baseline;
- command results;
- file/rule inventory;
- open/closed parameter table;
- bundle table;
- unresolved blockers and explicit PRD-review stop conditions.

### Next phase

Next, only after this audit is reviewed: MD-EXT-1 — Anchors, TOC, Links & Lazy Images.

## 20. MD-EXT-1 — Anchors, TOC, Links & Lazy Images

Status: COMPLETE / REVIEW-CLOSED. Evidence: [MD-EXT-1 Anchors, TOC, Links & Lazy Images](vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md).
Phase base: 579bda1850ceb955eb0796fec2cc3ec919b72a21. Next phase: MD-EXT-2 — Custom
Containers — COMPLETE / REVIEW-CLOSED.

### Goal

Add the P0 document-structure and generated-link/image behavior while establishing
the single final heading-ID model.

### Prerequisites

- MD-EXT-0 evidence is complete and reviewed.
- markdown-it-anchor insertion point and slugifyWithState behavior are proven.
- TOC sanitizer delta is approved.
- Current WikiLink renderer composition is understood.

### In scope

- Narrow custom heading suffix {#id}.
- One per-render auto/custom duplicate allocator.
- Standalone case-sensitive [[toc]] token and h2-h4 hierarchy.
- Generated Markdown/linkify HTTP(S) target/rel policy.
- Existing WikiLink/.md/relative/mailto/tel/fragment behavior preservation.
- loading="lazy" on normal Markdown-generated images only.
- Reader page-nav and PDF internal-anchor proof.

### Explicitly out of scope

- Containers, annotations, line numbers, code groups, snippets, includes.
- Generic attributes or raw HTML rewriting.
- Shiki runtime/tokenizer changes.
- A second TOC/page-nav slugger.

### Architecture changes

The phase adds the narrow heading/TOC module described in section 12 and registers it
around the named markdown-it-anchor rule. The anchor integration uses one per-render
allocator with uniqueSlugStartIndex: 2. Custom-anchor authorization checks the raw
heading inline source before mutating rendered children, so escaped/entity-produced
`{#id}` text remains literal and automatic. wikiLinks.ts composes existing internal
classification with generated external classification on the same token and calls
the final renderer exactly once. Its stable CSS class is presentation-only; target
privilege uses an opaque per-render marker passed through the render env and stripped
by the matching sanitizer context. The existing image renderer is wrapped rather
than replacing raw html_inline handling. PDF image readiness promotes lazy images to
eager only on the dedicated export surface when waiting for settlement requires it.

### Likely production files

- src/lib/markdown.ts;
- src/lib/wikiLinks.ts;
- new src/lib/markdownHeadings.ts or equivalent;
- src/style.css and possibly a narrowly scoped TOC stylesheet;
- src/composables/vault/useMarkdownRender.ts only if final record plumbing is needed;
- PDF style/helper file only for anchor/TOC print proof;
- src/lib/pdf-images.ts only for the phase-owned lazy-image readiness correction.

### Likely tests/E2E

- src/lib/__tests__/markdown.test.ts;
- src/lib/__tests__/wikiLinks.test.ts;
- src/composables/vault/__tests__/useMarkdownRender.test.ts;
- src/lib/__tests__/pdf-images.test.ts;
- new focused heading/TOC unit tests if the module is extracted;
- src/lib/__tests__/pdfExport.test.ts;
- e2e/markdown-visual.spec.ts and a focused anchor/TOC browser test;
- e2e/pdf-export.spec.ts or a focused PDF anchor/TOC test.

Required cases: auto/custom/duplicate ids, source-aware escaped/entity literal
headings, malformed metadata, inline heading Markdown, TOC hierarchy/no eligible
heading, resolver call count, generated external Markdown and linkify links, raw HTML
anchors unchanged, forged stable class/marker cannot gain target privilege, concurrent
render provenance isolation, internal links untouched, lazy images, unsafe URI, and
PDF IDs.

### Dependency changes

None expected. Reuse markdown-it-anchor and existing MarkdownIt.

### Sanitizer changes

Only the MD-EXT-0-approved nav/aria-label addition, plus a narrowly scoped generated
external target hook required by the current DOMPurify runtime. The hook accepts only
the matching opaque per-render provenance marker, normalizes trusted generated rel,
and strips that temporary marker. No forgeable class/data attribute grants trust; no
generic attrs or raw HTML mutation.

### Theme impact

Add reader light/dark styles for TOC only. IDs and links are theme-neutral. Theme
switching must not rerender Markdown.

### PDF impact

TOC remains static and printable. Internal hrefs must match final heading IDs in the
same clone. Generated external target/rel is not an interactive PDF requirement, but
href/text must remain safe. PDF readiness must settle Markdown-generated lazy images
without rereading resources.

### Security risks

Custom IDs and TOC labels can become injection surfaces. Use only the safe ID grammar,
token-derived escaped text, and final DOMPurify. Link policy must not touch raw
semantic HTML anchors.

### Concurrency/state risks

Heading collision state and TOC records are per render/env. Link resolver calls stay
render-scoped. No module-global slugger or TOC array.

### Manual acceptance

Render a document containing duplicate auto/custom headings, source-escaped and
entity-produced `{#id}` literals, [[toc]], inline formatting, generated HTTPS links,
a linkify URL, an internal .md link, a WikiLink, raw HTML <a>, and normal/raw images.
Verify visible suffix removal, final ids, one resolver call per real link,
target/rel only on generated external links, forged class/marker rejection, no marker
leakage, and lazy only on generated Markdown images.

### Validation commands

~~~
./node_modules/.bin/vitest run src/lib/__tests__/markdown.test.ts src/lib/__tests__/wikiLinks.test.ts src/composables/vault/__tests__/useMarkdownRender.test.ts
npm run typecheck
npm run build
npm run test:unit
~~~

Run focused Playwright and PDF suites if available; record unavailable browser
conditions rather than treating them as passing.

### Rollback boundary

Reverting MD-EXT-1 restores current automatic anchors, page-nav, link classifier, and
image output without changing Shiki, containers, or future resource APIs.

### Exit criteria

- One final ID source powers anchor permalink, reader page-nav, TOC, and PDF.
- Generated external HTTP(S) links have target=_blank and rel=noopener noreferrer;
  sanitizer privilege is proven by an opaque per-render marker, not a public class.
- Raw HTML anchors retain existing sanitizer behavior.
- Escaped/entity-produced custom-anchor-looking text remains literal and uses an
  automatic final ID.
- Lazy loading applies only to generated Markdown images.
- PDF image readiness settles generated lazy images on the export surface.
- Existing WikiLink and Markdown tests remain green.
- No generic attrs, second slugger, or Shiki change exists.

### Evidence required

[docs/design/vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md](vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md)
records the phase base SHA, changed files, source-aware anchor and opaque-provenance
security corrections, test results, browser/PDF evidence, bundle comparison, and
rollback/next-phase statement. The corrective follow-up commit SHA is recorded in the
final handoff rather than self-referenced here.

### Next phase

MD-EXT-2 — Custom Containers.

## 21. MD-EXT-2 — Custom Containers

Status: COMPLETE / REVIEW-CLOSED. The opaque-block and paragraph-context review
follow-ups are applied and recorded in the evidence handoff: [MD-EXT-2 Custom
Containers](vitepress-markdown-extensions-md-ext-2-containers.md).
Phase base: 4c86783fc847fda43a5eaba95e1d32621d79b835. Next phase: MD-EXT-3 — Shiki
Code Annotations & Unified Fence Metadata — NOT STARTED.

### Goal

Add the approved built-in info/tip/warning/danger/details container syntax with
deterministic titles, nesting, and callout coexistence.

### Prerequisites

- MD-EXT-1 final heading/render contract is complete.
- MD-EXT-0 selected the Nuvyn-owned parser and details {open} decision.
- Sanitizer open-attribute decision is recorded.

### In scope

- Built-in info, tip, warning, danger, details.
- Safe titles with ordinary inline Markdown only if tokenized safely.
- Longer outer fences and nested containers.
- Narrow literal {open} only if explicitly approved.
- Existing callouts/math/links/code coexistence.
- Reader and PDF styling.

### Explicitly out of scope

- Arbitrary custom type registration.
- Generic attrs, arbitrary class/id/style, ::: raw.
- Code-group interaction and code-group tab markup.
- Snippets/includes and resource reads.

### Architecture changes

Use a Nuvyn-owned block rule with fence-length matching rather than a general attrs
parser. The rule recognizes only the fixed type names and emits private container
tokens. The outer delimiter must be longer than a nested delimiter. Body content is
passed through normal MarkdownIt parsing using the same render env, so existing
callouts, links, math, and fenced code remain visible to their existing plugins.

The MD-EXT-2 review follow-up additionally requires close discovery to respect the
source ranges owned by earlier opaque block rules: `code`, `nuvyn_math_block`,
`fence`, and `html_block`. The implementation uses narrow range detectors aligned
with the installed MarkdownIt/Nuvyn rules, tracks paragraph context using the
actual silent paragraph-terminator chain, and jumps over an owned range only at a
real block boundary. HTML type 7, Nuvyn math, and indented code therefore do not
gain paragraph-interrupting behavior; HTML types 1–6 retain the behavior supplied
by MarkdownIt. It does not create a second MarkdownIt parser, render a substring,
or disable `html: true`; raw HTML remains under the existing DOMPurify boundary.

Unknown types and malformed/unclosed fences use safe ordinary/fallback handling and
must not swallow the document tail. details maps only the literal open modifier to
the boolean open attribute; all other brace text is not parsed as attrs.

### Likely production files

- src/lib/markdown.ts;
- new src/lib/markdownContainers.ts or equivalent;
- src/style.css and PDF stylesheet rules;
- src/lib/__tests__/markdown.test.ts;
- src/lib/__tests__/callouts.test.ts only for regression coverage.

### Likely tests/E2E

Unit: each built-in type/default title/custom title, inline title safety, body Markdown,
nested longer/shorter fences, unknown/unclosed/malformed input, opaque earlier
blocks at block boundaries and paragraph-context ownership (indented code, math,
fenced code, raw HTML), callout-in-container,
container-in-callout, ordinary blockquotes, and details open.

Browser: light/dark rendering, real native summary click interaction, nested layout,
and raw HTML delimiter ownership.

PDF: printable containers, details state, heading pagination, long content, and no
style/event leakage.

### Dependency changes

None expected. If a maintained markdown-it container candidate appears materially safer
than the Nuvyn-owned parser, stop and record the dependency decision before adding it.

### Sanitizer changes

div/details/summary/class are already allowed. Add open only as an exact boolean
feature attribute if approved. Never add arbitrary attrs based on title/type text.

### Theme impact

Add Nuvyn-owned container classes for reader light/dark, forced light/dark, and OS
fallback. No type name becomes a user-derived selector.

### PDF impact

Add printable light container/details styles and deterministic open/closed behavior.
Do not let a details widget or nested container break existing heading grouping or
oversized-block splitting.

### Security risks

Container type/title parsing can become generic attrs or arbitrary class injection.
Use a fixed enum, escaped/tokenized title, fixed class mapping, and the same sanitizer.

### Concurrency/state risks

Container parser state is token/render-local. Nested parsing must not mutate a
module-global delimiter stack or resolver context.

### Manual acceptance

Render nested outer/inner fences, raw HTML/math/indented-code ranges containing
delimiter-looking lines, a code fence containing ::: text, a callout inside a
container, a container inside a callout, unknown/unclosed forms, dangerous titles,
and details {open}. Verify unrelated trailing Markdown remains intact and use a
real Chromium summary click to prove native disclosure behavior.

### Validation commands

~~~
./node_modules/.bin/vitest run src/lib/__tests__/markdownContainers.test.ts src/lib/__tests__/markdown.test.ts src/lib/__tests__/callouts.test.ts
npm run typecheck
npm run build
npm run test:unit
~~~

Run focused Markdown visual/PDF tests and record results.

### Rollback boundary

Revert only container parser/CSS/tests. MD-EXT-1 heading, link, image, and Shiki
behavior remains intact.

### Exit criteria

- All five fixed types work with deterministic HTML/class contracts.
- Nested fences do not swallow code or document tail.
- Close discovery respects earlier opaque `code`, `nuvyn_math_block`, `fence`, and
  `html_block` source ranges according to parser context without a second
  MarkdownIt parse; type-7 HTML/math/indented continuation cases are not falsely
  treated as owned opaque blocks.
- Existing callouts remain unchanged and coexist.
- Generic attrs/raw bypass remain absent.
- Reader/PDF styles and details semantics are proven.

### Evidence required

docs/design/vitepress-markdown-extensions-md-ext-2-containers.md with parser decisions,
opaque-block and paragraph-context follow-up evidence, sanitizer delta, malformed-input evidence,
native-browser/PDF results, and rollback boundary.

### Next phase

MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata.

## 22. MD-EXT-3 — Shiki Code Annotations & Unified Fence Metadata

### Goal

Introduce one fence-info metadata parser plus an approved Shiki source-notation
transformer pipeline without creating a second runtime or changing the H8 token-color
ownership. The two channels remain separate: `parseFenceMeta(info)` parses fence info
only, while `[!code ...]` is consumed from code source by Shiki notation transformers.

### Prerequisites

- MD-EXT-2 container parser is complete.
- MD-EXT-0 has captured actual transformer APIs and the focus bound.
- Existing H8 Shiki tests and generated CSS owner are green.

### In scope

- Unified fence-info metadata representation.
- {1,3-5} line metadata highlighting.
- [!code highlight], [!code focus], focus:N, ++/--, warning/error/info.
- Shiki transformer ordering and class-only annotation CSS.
- Language discovery using parsed language rather than raw metadata.
- Exact mermaid/markmap behavior for bare identifiers.

### Explicitly out of scope

- highlight:N.
- Line-number visual gutter.
- Code groups.
- Snippets/includes.
- New Shiki runtime/style transformer.

### Architecture changes

Extend src/lib/shiki.ts to accept the parsed FenceMeta and pass its fence-info range
metadata to the actual Shiki 4.4.3 meta contract in codeToHtml. Add
src/lib/fenceMeta.ts if confirmed. The same module must not parse source comments.
Shiki source notation is handled independently by the approved notation transformer
pipeline. Annotations are fixed classes; the existing styleTransformer remains
last/sole owner. The Nuvyn single-line highlight adapter or equivalent source-level
gate prevents the installed range-capable transformer from silently shipping
deferred highlight:N.

### Likely production files

- src/lib/fenceMeta.ts (reuse only; no source change expected);
- src/lib/markdown.ts;
- src/lib/shiki.ts;
- src/shiki.css and/or narrowly scoped style.css additions;
- src/lib/__tests__/shiki.test.ts;
- src/lib/__tests__/markdown.test.ts;
- PDF helper/style file for printable annotations.

### Likely tests/E2E

Fence-info unit tests: language extraction with metadata, {1,3-5}, line-number
modifiers, labels, malformed info, and exact special fences. Source-notation tests:
all approved annotations, focus:N bounds, malformed N, deferred highlight:N,
class-only output, transformer reuse, unknown/special fences, concurrent languages,
and style registry single owner. No test should imply that parseFenceMeta() returns
focus/diff/error notation.

Browser: reader theme matrix, annotation visibility, no token rerender on theme switch,
long wrapped annotated code.

PDF: computed token colors, highlight/focus/diff/severity distinction, printable light
under every reader state, wrapping/pagination.

### Dependency changes

None. Reuse @shikijs/transformers 4.4.3.

### Sanitizer changes

None expected. Generated classes already pass the class allowlist; style remains
forbidden and generated CSS stays outside article HTML.

### Theme impact

Add fixed Nuvyn annotation classes for light/dark/forced/OS states. Diff/severity
must have a non-color cue where practical. No Markdown rerender or token retokenization.

### PDF impact

Add printable-light annotation selectors and computed-style proof. Preserve Shiki
--shiki-light token color and the one PDF stylesheet owner.

### Security risks

Fence metadata and source notation must not produce arbitrary classes, styles, or CSS.
Malformed fence info/notation remains safe source/fallback and never throws.

### Concurrency/state risks

The highlighter and style transformer stay singleton. FenceMeta is per block/render
and derived only from info; source-notation transformation is per codeToHtml
invocation. No codeToHtml call may create a second style registry or module-global
notation state.

### Manual acceptance

Render representative JS/TS/Java/Python fences with fence info such as
`ts {1,3-5}:line-numbers [config.ts]`, then separately use code-body notation such as
`foo() // [!code focus:3]` and `bar() // [!code error]`. Include malformed ranges,
focus:0, focus:-1, focus:abc, huge focus, deferred highlight:N, mermaid{1}, and
markmap{1}. Confirm only exact bare mermaid/markmap bypasses Shiki and that no
source-notation case is routed through parseFenceMeta().

### Validation commands

~~~
./node_modules/.bin/vitest run src/lib/__tests__/shiki.test.ts src/lib/__tests__/markdown.test.ts
npm run typecheck
npm run build
npm run test:unit
~~~

Run e2e/markdown-shiki-theme.spec.ts, e2e/markdown-shiki-security.spec.ts, and
e2e/pdf-export-shiki.spec.ts when browser environment is available.

### Rollback boundary

Remove annotation transformers and fence metadata activation while retaining the H8
normal Shiki renderer, singleton, CSS owner, and MD-EXT-1/2 behavior.

### Exit criteria

- One fence-info parser feeds discovery and rendering.
- The approved Shiki source-notation pipeline consumes code-body directives separately.
- All approved annotations work with class-based output.
- focus:N is bounded and uses official semantics.
- highlight:N remains deferred.
- Special fences remain exact and outside normal annotations.
- Security and printable-light computed-style proof passes.

### Evidence required

docs/design/vitepress-markdown-extensions-md-ext-3-code-annotations.md with actual
4.4.3 transformer evidence, order, tests, CSS snapshot, PDF computed colors, and
deferred-feature proof. This evidence is now recorded for the completed phase.

### Review follow-up closure

The MD-EXT-3 review follow-up hardened two boundaries without changing phase
scope: deferred source-notation restoration is invocation-local and collision-free
against author source, and FenceMeta range expansion has a shared 100000 total
work budget per parse. Duplicate ranges consume budget before Set deduplication;
over-budget tokens are recorded as malformed and skipped atomically. The
follow-up evidence and tests are recorded in the linked MD-EXT-3 document.

### Next phase

[MD-EXT-3 evidence](vitepress-markdown-extensions-md-ext-3-code-annotations.md)

[MD-EXT-4 evidence](vitepress-markdown-extensions-md-ext-4-line-numbers.md)

[MD-EXT-5 evidence](vitepress-markdown-extensions-md-ext-5-code-groups.md)

MD-EXT-5 — Code Groups — COMPLETE / REVIEW-CLOSED.

The MD-EXT-5 review follow-up is closed. The sanitizer retains `tabindex` only
for exact string values `0` and `-1`, removes all other author values, and keeps
generated roving tabs intact. The grouped PDF browser evidence selects the
non-first panel in a dark reader, then proves all panels remain in source order
and the grouped TypeScript panel preserves line numbers, `.line.error`, a
printable annotation background, and a computed token color equal to
`--shiki-light` and different from `--shiki-dark`. No parser, mount, Shiki,
FenceMeta, or PDF production change was required.

## 23. MD-EXT-4 — Line Numbers

Status: COMPLETE / REVIEW-CLOSED. Evidence: [MD-EXT-4 Line Numbers](vitepress-markdown-extensions-md-ext-4-line-numbers.md).

The MD-EXT-4 reader review follow-up is closed. Generic `.shiki span` theme
backgrounds previously matched the structural `.nuvyn-line-number` and
`.nuvyn-line-content` children and could cover annotation backgrounds owned by
`.line`. The focused CSS fix scopes `background-color: transparent` to those two
wrappers under `pre.shiki.nuvyn-line-numbers` only. Annotation classes,
token-span styling, the line-number DOM, Shiki transformers, PDF CSS, and the
sanitizer remain unchanged. The MD-EXT-4 browser evidence now proves the parent
`highlighted` and `error` backgrounds remain visible while both structural
children are transparent in light and dark reader themes.

### Goal

Add opt-in, bounded, accessible line-number gutters without changing the global
default or weakening the sanitizer.

### Prerequisites

- MD-EXT-3 fence-info metadata and source-notation output are stable.
- MD-EXT-0/3 has approved the numeric bounds and HAST hook.

### In scope

- :line-numbers.
- :no-line-numbers.
- :line-numbers=N with bounded positive N.
- Normal Shiki and escaped unknown-language fallback structure.
- Wrapping, copy-selection, accessibility, theme, and PDF behavior.

### Explicitly out of scope

- Code groups.
- Copy-code button.
- Line highlighting semantics beyond MD-EXT-3.
- Inline styles, CSS custom properties from metadata, or source-derived CSS.

### Architecture changes

Use a trusted structural transform around each Shiki .line:

~~~html
<span class="line">
  <span class="nuvyn-line-number" aria-hidden="true">10</span>
  <span class="nuvyn-line-content">...</span>
</span>
~~~

The line-number text is generated from bounded parsed metadata, not source HTML. CSS
sets user-select:none on the gutter, keeps it out of screen-reader traversal through
aria-hidden, preserves wrapped content width, and avoids inline style/custom property
state. Unknown-language fallback uses the same escaped structural contract when
line numbers are requested.

The implementation uses a per-fence `nuvyn:line-numbers` Shiki HAST code hook. It
runs after the approved MD-EXT-3 annotation hooks, preserves annotation classes on
each original `.line`, and leaves the singleton `style-to-class` transformer last.
It adds no FenceMeta parser, no second highlighter, and no module-global counter.
Shiki 4.4.3 represents a source ending in a newline with a final empty `.line`; the
fallback deliberately matches that logical-line behavior.

### Likely production files

- src/lib/fenceMeta.ts;
- src/lib/shiki.ts or a focused Shiki line transform module;
- src/lib/markdown.ts fallback renderer;
- src/shiki.css and/or style.css;
- src/lib/__tests__/shiki.test.ts and markdown.test.ts;
- src/lib/__tests__/pdfExport.test.ts;
- e2e/pdf-export-shiki.spec.ts or focused line-number specs.

### Likely tests/E2E

Test line numbers with syntax, {ranges}, focus, diff, warning/error, custom start,
wrapped line, :no-line-numbers, malformed/large start, empty code, unknown fallback,
copy selection, screen-reader tree/aria-hidden, reader themes, and PDF.

### Dependency changes

None.

### Sanitizer changes

None expected: span, class, aria-hidden are already allowed. No data attribute is
needed for line numbers.

### Theme impact

Gutter colors, borders, and focus/diff treatment have light/dark/forced/OS selectors.
Token colors remain Shiki CSS variables. Theme switching does not rerender.

### PDF impact

Printable gutters use fixed light colors, wrap with code, remain within A4 width, and
are not clipped. PDF may retain aria-hidden structural attributes without using them
as a rendering dependency.

### Security risks

The main risks are arbitrary CSS and text pollution. Bounded structural numbers and
fixed classes prevent both.

### Concurrency/state risks

Line numbering is per code block. It must not share a counter between code blocks or
renders; a reset/empty block remains deterministic.

### Manual acceptance

Compare code copy/selection with and without line numbers, inspect accessibility
tree, resize a long wrapped code block, switch theme without HTML changes, and export
with a custom start under a dark reader.

### Validation commands

~~~
./node_modules/.bin/vitest run src/lib/__tests__/shiki.test.ts src/lib/__tests__/markdown.test.ts src/lib/__tests__/pdfExport.test.ts
npm run typecheck
npm run build
npm run test:unit
~~~

Run focused browser/PDF layout tests.

### Rollback boundary

Remove only line-number transform/CSS/metadata activation. Annotations and normal
Shiki output remain.

### Exit criteria

- Default remains OFF.
- All supported modes are bounded and malformed input is safe.
- Gutter is structural, aria-hidden, selectable-safe, and wraps correctly.
- Unknown fallback and PDF output remain readable.
- No inline style or arbitrary CSS path exists.

### Evidence required

docs/design/vitepress-markdown-extensions-md-ext-4-line-numbers.md with DOM,
accessibility, copy, wrapping, PDF, and bound evidence.

### Next phase

[MD-EXT-5 evidence](vitepress-markdown-extensions-md-ext-5-code-groups.md)

[MD-EXT-6 evidence](vitepress-markdown-extensions-md-ext-6-resources.md)

MD-EXT-6 — Safe Snippets & Markdown Includes — COMPLETE / REVIEW-CLOSED.

## 24. MD-EXT-5 — Code Groups

### Goal

Add accessible static code groups with independent reader interaction and complete
all-panel PDF export.

### Prerequisites

- MD-EXT-2 container token/parser model is stable.
- MD-EXT-3/4 fence metadata and rendered code structure are stable.
- Sanitizer delta for button/ARIA attributes is approved.
- Existing RenderedMarkdown mount cleanup has been inspected.

### In scope

- ::: code-group with labeled fenced members.
- Static all-panel DOM.
- Keyboard/click post-v-html enhancement.
- Multiple groups and rerender/unmount cleanup.
- Reader theme behavior.
- PDF all-panel source-order export.

### Explicitly out of scope

- Snippet/include resource reads.
- Vue directives/components in Markdown.
- Active-tab persistence across documents.
- Copy button or code-group remote loading.

### Architecture changes

Extend the Nuvyn container token path with a special code-group representation that
captures validated fence labels and wraps the existing ordinary fence renderer output.
It emits the static structure in section 15.3. Add useCodeGroupMount.ts to
RenderedMarkdown’s post-v-html lifecycle. It uses root-scoped event delegation and
removes listeners/observers on rerender/unmount.

The tab/panel ids use an internal per-render scope prefix plus deterministic indexes.
User labels are escaped display text only. No generic data-* attribute is introduced.

### Likely production files

- src/lib/markdown.ts and src/lib/markdownCodeGroups.ts;
- src/components/vault/RenderedMarkdown.vue;
- new src/composables/useCodeGroupMount.ts;
- src/style.css and PDF stylesheet/helper;
- src/lib/__tests__/markdown.test.ts;
- new/focused component lifecycle tests;
- src/lib/__tests__/pdfExport.test.ts;
- e2e focused code-group reader/PDF specs.

### Likely tests/E2E

Unit: labels, malformed groups, nested code, duplicate labels, empty group, all
panels, sanitizer markup, id uniqueness, no directives, and output order.

Component/browser: click/keyboard switching, focus/ARIA state, multiple groups,
same source in two surfaces, rerender cleanup, theme switch without retokenization.

PDF: export after selecting second tab, all labels/panels, hidden/active state
independence, long panels/wrapping/pagination.

### Dependency changes

None. No tab framework.

### Sanitizer changes

Add only approved button/ARIA attributes: button, aria-selected, aria-controls,
aria-labelledby, and tabindex; role is already allowed. The globally allowed
`tabindex` name is enforced by a final-value hook: only exact string values `0`
and `-1` survive, and every other author value is removed. Do not add onclick,
style, wildcard data, or Vue directive attrs.

### Theme impact

Static tab/panel controls and all code token palettes work in light/dark/forced/OS
states. Theme changes do not change active state or retokenize code.

### PDF impact

preparePdfArticleHtml() or a narrow PDF clone hook exposes every panel and includes
its label. It must not call the resource resolver, rerender Shiki, or rely on the
reader’s active tab.

### Security risks

Generated controls are interactive but static. DOMPurify must retain only exact
semantic tags/ARIA; all behavior comes from the Nuvyn enhancement, not author HTML.

### Concurrency/state risks

Each rendered article root has its own mount state and listener cleanup. Two groups
and two surfaces cannot share active tab or generated id state.

### Manual acceptance

Render two code groups with two/three labels, select the second tab, rerender the
document, switch theme, and export. Verify the reader has one visible panel per group
while the PDF includes all panels in source order.

### Validation commands

~~~
./node_modules/.bin/vitest run src/lib/__tests__/markdownCodeGroups.test.ts src/composables/__tests__/useCodeGroupMount.test.ts src/lib/__tests__/markdown.test.ts src/lib/__tests__/markdownContainers.test.ts src/lib/__tests__/pdfExport.test.ts
npm run typecheck
npm run build
npm run test:unit
~~~

Run focused reader/PDF Playwright tests plus existing PDF layout/pagination/stress
regressions.

### Rollback boundary

Remove code-group parser, mount, styles, and PDF expansion while keeping MD-EXT-1
through MD-EXT-4 behavior and existing containers.

### Exit criteria

- Static DOM survives DOMPurify and contains all panels.
- Keyboard/click behavior is accessible and root-scoped.
- No Vue template execution or inline handler exists.
- Rerender/unmount cleanup is leak-free.
- PDF always exports all labeled panels.

### Evidence required

[MD-EXT-5 Code Groups](vitepress-markdown-extensions-md-ext-5-code-groups.md) with
sanitized DOM, ARIA/lifecycle, interaction, PDF all-panel, and no-reread evidence.

### Status

COMPLETE / REVIEW-CLOSED. The implementation uses the existing MarkdownIt fence
token path, a root-scoped `useCodeGroupMount`, exact sanitizer additions, and a
clone-only PDF all-panel transformation. The review follow-up additionally
enforces the exact `tabindex` values `0` and `-1` at the final sanitizer boundary
and proves grouped PDF line numbers, annotations, and printable-light Shiki
token colors in Chromium. MD-EXT-6 has since been implemented and is review-closed.
At the MD-EXT-5 handoff, MD-EXT-7 was ready to start but had not started.

### Next phase

MD-EXT-6 — Safe Snippets & Markdown Includes — COMPLETE / REVIEW-CLOSED.

## 25. MD-EXT-6 — Safe Snippets & Markdown Includes

### Goal

Add the approved P2 resource core through an authenticated, root-confined, bounded
text/resource boundary while preserving source context and final Shiki discovery.

### Prerequisites

- MD-EXT-1 final heading/TOC IDs are stable.
- MD-EXT-3 fence-info parser and source-notation pipeline are stable.
- MD-EXT-5 static code-group/final HTML contract is stable.
- MD-EXT-0 has approved server route, extension allowlist, asset policy, bounds,
  resolver context, and cancellation design.

### In scope

- Safe snippet file read.
- @/ root references.
- ./ and ../ source-relative logical resolution.
- Canonical path/root confinement.
- Authenticated physical read.
- UTF-8 text model and extension policy.
- Bounded line ranges and basic named regions.
- Markdown include and nested include.
- Include cycles/depth/file/final-size limits.
- Included source context for links/images/WikiLinks.
- Shiki discovery after expansion.
- Safe local resource error placeholders.

### Explicitly out of scope

- Heading/section include.
- Code-file inclusion inside fences.
- highlight:N.
- Remote resources, SSRF, arbitrary filesystem, browser filesystem.
- PDF reread of resources.
- Generic server file download endpoint.

### Architecture changes

Add a client/resource resolver interface, server canonical-path route/service, and
per-render expansion representation from section 14. Extend render options with
sourcePath/resourceResolver/signal/renderScope only at this phase. Keep existing
callers compatible through optional fields.

The server authenticates every request through the existing authBoundary, validates
canonical logical path, enforces kind/extension/size, calls readSafeRelativeFile(),
decodes fatal UTF-8, and returns generic errors. The client does not receive or send
absolute paths.

Resource expansion occurs before final MarkdownIt parse/discovery. Included code is
escaped literal source, not executable HTML, and uses the existing Shiki path.
Range metadata distinguishes `{N}` as a single line (`start === end`), `{N-M}`
as an inclusive closed range, and `{N,}` as the only open-ended form; `N-` is
invalid. The same selection contract applies to snippets and includes.

A shared narrow MarkdownIt-compatible backtick source-position helper receives
one actual `inline` token's source and its complete real child sequence. It
advances a monotonic raw-source cursor through exact-source non-code children,
especially `html_inline`, and through a normal Markdown link label before the
matching `link_close` confirms the current outer `]`. Only then does it consume
the full raw destination/title surface using the running MarkdownIt's link
helpers. It records those ranges as unavailable to later code-span candidates,
and uses marker length/normalized content only to verify an actual
`code_inline` child. Future `]` scanning at `link_open` is forbidden; a failed
proof fails closed rather than rewinding the cursor.
Resource expansion checks the exact standalone directive slice, not a whole-line
blanket; ownership is decided before valid or malformed resource parsing. The
helper never pairs backticks across MarkdownIt inline blocks, so one-line/
multi-line and variable-length real code spans remain literal while an unmatched
opener in one paragraph cannot suppress a directive in another. Same-content
raw backticks in an HTML attribute or Markdown link title cannot impersonate a
later real `code_inline` mapping. Images remain single-token and retain their
existing narrow source-ownership path.

### Likely production files

- new server/markdownResources.ts and server/routes/markdownResources.ts or equivalent;
- server/index.ts route mount;
- server/paths.ts only if a narrowly scoped canonical/type helper is necessary;
- new src/lib/markdownResources.ts;
- new src/lib/markdownInlineSource.ts for narrow code-span source positions;
- src/lib/markdown.ts and useMarkdownRender.ts for options/expansion;
- src/lib/wikiLinks.ts/shared/linkResolve.ts for optional source context;
- VaultView.vue, ReadingPane.vue, RenderedMarkdown.vue, PdfExportSurface.vue for
  source-path forwarding;
- src/lib/pdf-readiness.ts only if asset readiness requires a narrow hook;
- unit/server/client/PDF tests and new resource E2E.

### Likely tests/E2E

Client unit: @/, ./, ../ within root, root escape, absolute/Windows/UNC/backslash/
NUL/protocol rejection, nested source context, ranges/regions, malformed directives,
cycles/depth/size, generic errors, final Shiki language discovery, resolver counts,
concurrent renders, cancellation.

The resource expansion budget is the exact UTF-8 byte length of the final
`lines.map(({ text }) => text).join('\n')`, including every separator newline.
It is enforced incrementally with per-render emitted-line accounting and a final
defensive equality/limit check. Cache hits avoid reads but never waive the cost
of inserting the cached content again. Failed local directives roll back all
budget state before emitting their placeholder.

When one MarkdownIt inline token spans root/include/root lines, source context is
assigned per child while walking `softbreak`/`hardbreak` boundaries and raw
`code_inline` source ranges from the same child-guided helper. Exact `html_inline`
source and complete Markdown link labels are consumed before later code-span
matching, so identical raw backticks in an HTML attribute or link label/title
cannot move the source cursor or impersonate the real code span. The break retains
the preceding line; a multi-line code span advances by the exact source line
endings it consumes, rather than by normalized rendered content. A failed exact
mapping is represented as unknown rather than guessed, and a link close never
rewinds the cursor. No global source cursor, whole-document backtick scan, second
full inline parser, or paragraph-semantic rewrite is allowed.

Server: auth required, canonical path, safe physical resolver, symlink/junction/race,
missing/directory/binary/invalid UTF-8/unsupported/oversized, asset MIME policy,
concurrent reads and abort.

Browser/PDF: included headings/TOC, relative links/images, snippet highlighting,
code groups with included snippets, safe visible errors, code-span opacity and
source-context directionality, exact local-image endpoint no-reread proof,
forced snapshot-failure fail-closed proof, settled HTML, and live-reader
isolation.

### Dependency changes

None expected. Reuse auth, server/paths.ts, Hono, and existing client authFetch. Any
new filesystem abstraction or decoder package requires a stop/review.

### Sanitizer changes

Prefer none. Expansion output is ordinary untrusted Markdown and passes the existing
sanitizer. Safe error placeholders use already allowed elements/classes. Resource
endpoint responses are not trusted HTML.

### Theme impact

No new theme semantics. Included content uses the same reader/PDF CSS and Shiki
generated CSS. Resource errors remain readable in all four reader theme states.

### PDF impact

PDF receives final articleHtml from the resource-aware render. It does not
re-expand, re-tokenize, fetch the filesystem, or call the resource resolver.
Image readiness and existing widget readiness must remain settled; included
code/TOC/links participate in normal clone behavior. For an already-settled
same-origin local Markdown image, the export-only clone materializes the image
without first cloning its resource endpoint URL, and html2canvas ignores live
reader article roots outside the export root. The browser proof must show zero
additional `/api/markdown-resources?kind=image` requests during preparation and
download, while leaving the live reader unchanged. If snapshotting fails, the
clone must omit local resource `src`/`srcset`/`sizes` instead of restoring the
endpoint URL; remote/raw images retain their existing behavior.

### Security risks

This is the highest-risk phase: path traversal, symlink races, auth mistakes, SSRF,
binary/encoding abuse, source disclosure, cycles, amplification, resolver context,
and error leakage. Any inability to prove the full boundary blocks the phase.

### Concurrency/state risks

Per-render resource cache/stack/context and AbortSignal are mandatory. Concurrent
documents must not share source path, cache, include stack, WikiResolver context, or
visible error state. Existing stale-render cancellation remains authoritative.

### Manual acceptance

Use:

~~~text
source: guides/java/index.md
<<< ../shared/example.ts
<!--@include: ./parts/details.md-->
~~~

Verify canonical paths, included headings/TOC, relative image/link rebasing, nested
WikiLinks, Shiki grammar preparation after expansion, cycle/depth/size/encoding errors,
and no host path disclosure. Verify `{2}` versus `{3,}`, exact UTF-8 expansion
accounting, valid and malformed directive-looking code spans, variable-length
backticks, an unmatched opener across separate MarkdownIt blocks, same-content
backticks inside `html_inline` before a real code span, unrelated raw backticks
before a real code span, and both directions of a merged root/include/root
paragraph with per-child source context. Test a reader export
after selecting a code-group tab; the PDF must use settled HTML and make no
additional local-image endpoint request. Force local-image snapshot failure and
verify the prepared clone contains no endpoint URL and the live reader is unchanged.

### Validation commands

~~~
./node_modules/.bin/vitest run src/lib/__tests__/markdownInlineSource.test.ts src/lib/__tests__/markdownResources.test.ts src/lib/__tests__/markdown.test.ts src/lib/__tests__/wikiLinks.test.ts src/lib/__tests__/pdfExport.test.ts src/lib/__tests__/pdf-readiness.test.ts
./node_modules/.bin/vitest run server/__tests__/paths.test.ts server/routes/markdownResources.test.ts server/__tests__/auth-middleware.test.ts
npm run typecheck
npm run build
npm run test:unit
~~~

Run resource-focused Playwright and PDF suites. Run history/recovery suites only
through their existing package scripts; do not invent a resource test script.

### Rollback boundary

Remove resource client, endpoint, expansion, and source-context changes. Static
Markdown extensions MD-EXT-1 through MD-EXT-5 remain available, and the existing
posts API/path helpers remain unchanged.

### Exit criteria

- Server is authenticated and canonical-path/root/symlink/race safe.
- Physical helper still rejects raw dot segments.
- Text/UTF-8/extension/size/depth/cycle policy is enforced.
- Source context survives nested expansion for links/images/WikiLinks and
  multi-line `code_inline` spans.
- Final discovery occurs after expansion.
- Resource failures are local and generic.
- PDF does not reread resources; the real browser image-endpoint delta after the
  settled export surface is zero, including forced local-image snapshot failure.

### Evidence required

docs/design/vitepress-markdown-extensions-md-ext-6-resources.md with endpoint contract,
path proof, auth, exact range and UTF-8 byte limits, source-context traces,
resolver/network counts, cancellation, browser, PDF, and negative security cases.

### Status

COMPLETE / REVIEW-CLOSED. The implementation expands approved snippets and Markdown
includes before final MarkdownIt discovery/render, keeps logical source-relative
resolution separate from the strict physical path boundary, forwards included source
context to links/images/WikiLinks, and preserves the settled-HTML PDF contract. The
review follow-ups close single-line/closed/open-ended range semantics, exact final
UTF-8 byte accounting including separators, merged-inline per-child source context,
MarkdownIt-inline-block-scoped code-span ownership and source-line advancement,
the authenticated local-image PDF no-reread boundary, fail-closed local-image
snapshot failure, Markdown-link destination/title ownership, and child-driven
Markdown-link label ownership. The latest ownership follow-up does not touch PDF
production code; it makes the complete actual child sequence authoritative,
consumes exact `html_inline` and full Markdown-link raw surfaces only after the
actual label children and `link_close` prove the outer boundary, and rejects
marker/content-only identity for same-content raw backticks. The evidence document
records the authenticated route, bounded text/image policy, per-render
cache/stack/cancellation behavior, focused tests, browser network counts,
failure-mode PDF proof, the installed MarkdownIt 14.2.0 parser/link-rule audit,
and the known aggregate unit-suite environment limitations. MD-EXT-6 is
review-closed. At the MD-EXT-6 handoff, MD-EXT-7 was ready to start but had not
started.

### Next phase

At the MD-EXT-6 handoff, MD-EXT-7 — Full Regression, Bundle Audit & Release Gate —
READY TO START / NOT STARTED.

## 26. MD-EXT-7 — Full Regression, Bundle Audit & Release Gate

Status: COMPLETE / REVIEW-CLOSED. Evidence: [MD-EXT-7 Release Gate](vitepress-markdown-extensions-md-ext-7-release-gate.md).
Program status: COMPLETE / REVIEW-CLOSED. Release gate: PASS. External review:
APPROVED.

### Goal

Prove the complete approved scope, bundle behavior, security invariants, reader/PDF
behavior, accessibility, and documentation closure. This is a release gate, not a
feature-development phase.

### Prerequisites

- MD-EXT-0 through MD-EXT-6 evidence documents are complete.
- All deferred/rejected rows are explicitly absent or out of scope.
- No unresolved stop condition remains.

### In scope

- Full unit/client/server/integration/browser/PDF regression.
- Production typecheck/build and bundle comparison to MD-EXT-0.
- Shiki singleton/lazy grammar/no duplicate runtime audit.
- Sanitizer/security and resource server audit.
- Reader theme/accessibility/manual acceptance.
- Documentation and compatibility matrix closure.

### Explicitly out of scope

- Large feature implementation.
- H9 or any Shiki migration reopening.
- Enabling deferred syntax without PRD review.
- Silently classifying real product failures as environmental.

### Architecture changes

None expected. If a substantial defect is found, block release and create a focused
follow-up phase/commit rather than hiding it in the release-gate commit.

### Likely production files

Normally none. Evidence docs and test fixtures may change. A narrowly justified
test-only or documentation correction may be made, but production fixes are separate
reviewable work.

### Likely tests/E2E

Run:

~~~text
Markdown unit, Shiki unit, WikiLink/resolver, callout, math, Mermaid, MarkMap,
sanitizer/security, reader theme, PDF Shiki, PDF layout, PDF pagination, PDF stress,
custom anchors, TOC, containers, annotations, line numbers, code groups,
resource/server path security, browser interaction, accessibility-critical tests
~~~

Also run existing scripts:

~~~text
npm run typecheck
npm run test:unit
npm run test:history-integration
npm run test:recovery-integration
npm test
npm run build
~~~

Run npm ci only in a clean CI-like checkout or disposable workspace where practical;
do not destroy the developer’s working node_modules during a release review.

### Dependency changes

No new dependency is expected. Inspect package.json/package-lock.json and production
bundle for accidental VitePress/MDX/generic attrs/duplicate Shiki packages.

### Sanitizer changes

Review the final delta ledger and security tests. Any unreviewed tag/attr/data wildcard
or FORBID_ATTR change blocks release.

### Theme impact

Run light/dark/forced light/forced dark/OS fallback and CSS-only switch proof, including
annotation, line-number, code-group, TOC/container, and PDF states.

### PDF impact

Run all PDF suites and manually inspect a representative extension-rich document:
TOC/anchors, containers/details, annotated/numbered code, all code-group panels,
snippets/includes, images, Mermaid, MarkMap, math, long lines, pagination, and cleanup.

### Security risks

Any release-critical negative case fails the gate. Do not waive root escape, auth,
sanitizer, style, event, URI, SSRF, cycle, error disclosure, or active-tab export
failures as “known”.

### Concurrency/state risks

Inspect singleton count, render-context isolation, resource cache lifecycle, mount
cleanup, stale render behavior, and bundle for duplicate highlighter/MarkdownIt
instances.

### Manual acceptance

Use separate focused fixtures rather than one huge pagination-sensitive kitchen sink:
anchors/TOC, containers, annotations/line numbers, code groups, resource expansion,
and a combined reader/PDF smoke document. Confirm deferred features remain absent.

### Validation commands

Use the actual package scripts listed above plus focused existing Playwright commands
from package.json. Capture raw command, exit code, test counts, warnings, bundle assets,
and browser/PDF artifacts in the release-gate evidence.

### Rollback boundary

The release gate does not make feature changes. If it fails, keep the last phase
completion as the release candidate and fix the owning phase in a separate commit.

### Exit criteria

Every PRD DoD item is PASS or explicitly OUT OF RELEASE SCOPE for deferred features.
Typecheck, unit, integration, build, relevant browser/PDF, security, bundle, and
documentation checks are actual PASS. No H9 exists and Shiki H0-H8 remains closed.

### Evidence required

docs/design/vitepress-markdown-extensions-md-ext-7-release-gate.md with the phase base
SHA, all command results, feature matrix, security/PDF/bundle evidence, deferred
ledger, release verdict, and final implementation commit references.

### Next phase

The MD-EXT program is COMPLETE / REVIEW-CLOSED. No MD-EXT-8 phase is planned by
this program. Future Markdown features require a new independently approved
scope/PRD. Otherwise stop at the owning phase; do not advance by relabeling a
failure.

## 27. Phase Summary Table

| Phase | Behavior | Primary files | Primary risk | Sanitizer delta | PDF impact | Exit condition |
| --- | --- | --- | --- | --- | --- | --- |
| MD-EXT-0 | Audit only | Evidence doc; read-only architecture files | Planning from false assumptions | None | Baseline only | All parameters/evidence recorded |
| MD-EXT-1 | Anchors, TOC, links, lazy images | markdown, wikiLinks, heading module, styles | ID/link drift and renderer overwrite | nav/aria-label if approved | Same final ids/TOC | One final ID model and generated-link policy proven |
| MD-EXT-2 | Built-in containers | markdown/container module/styles | Fence/nesting ambiguity | open only if approved | Printable containers/details | Safe nested parser and callout coexistence |
| MD-EXT-3 | Shiki annotations/fence-info metadata | fenceMeta, shiki, markdown, CSS | Transformer order/style ownership | None | Computed annotation/token proof | Approved annotations class-based |
| MD-EXT-4 | Line numbers | shiki/fallback/CSS | Copy/accessibility/inline CSS | None | Wrapped printable gutter | Bounded structural gutter |
| MD-EXT-5 | Code groups | markdown, RenderedMarkdown, mount, CSS/PDF | v-html interaction and active-tab export | button/ARIA exact additions | All panels | Accessible static DOM and all-panel PDF |
| MD-EXT-6 | Snippets/includes/resources | client/server resolver, paths boundary, render options | traversal/auth/source context/amplification | None preferred | No reread; settled HTML | Root-safe bounded expansion |
| MD-EXT-7 | Full release gate | Evidence/docs/tests/fixtures | Hiding real failures | Final ledger audit | Full matrix | DoD PASS and bundle/security proof |

## 28. Cross-Phase Test Matrix

| Feature/contract | Unit | Component | E2E/browser | Security | PDF | First required phase | Later regression |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Automatic/custom heading IDs | markdown.test.ts, heading module test | useMarkdownRender.test.ts | anchor/TOC browser test | invalid id/generic attrs | pdfExport.test.ts | MD-EXT-1 | MD-EXT-6/7 |
| Duplicate auto/custom IDs | heading module test | page-nav extraction | TOC navigation | collision registry isolation | internal hrefs | MD-EXT-1 | MD-EXT-6 |
| [[toc]] standalone | markdown.test.ts | RenderedMarkdown/RightRail as needed | TOC click/keyboard | safe title text/no resolver | static nav | MD-EXT-1 | MD-EXT-6/7 |
| Generated external links | wikiLinks.test.ts/markdown.test.ts | none | target/rel and focus | raw HTML distinction | href/text | MD-EXT-1 | MD-EXT-7 |
| Lazy Markdown images | markdown.test.ts | readiness tests | image load/error/layout | URI unchanged | image inclusion | MD-EXT-1 | MD-EXT-7 |
| Existing WikiLinks/.md links | wikiLinks.test.ts | ReadingPane | navigation | resolver counts | links survive clone | MD-EXT-1 | MD-EXT-6/7 |
| Containers | markdown/container tests | callout regression | reader/details | fixed classes/no attrs | print/layout | MD-EXT-2 | MD-EXT-7 |
| Unified fence language/meta | fenceMeta/markdown tests | none | metadata rendering | malformed safe | code output | MD-EXT-3 | MD-EXT-4/5/6 |
| Shiki annotations | shiki.test.ts/markdown.test.ts | none | theme/no rerender | class-only/style forbidden | computed colors | MD-EXT-3 | MD-EXT-7 |
| Deferred highlight:N | markdown/shiki negative test | none | no range behavior | no arbitrary class | no special output | MD-EXT-3 | MD-EXT-7 |
| Line numbers | shiki/markdown tests | RenderedMarkdown if needed | keyboard/copy/a11y/wrap | no inline CSS | printable gutter | MD-EXT-4 | MD-EXT-7 |
| Code groups | markdown/code-group tests | useCodeGroupMount test | click/keyboard/multiple groups | exact ARIA/no handlers | all panels | MD-EXT-5 | MD-EXT-7 |
| Resource logical paths | resource path unit | useMarkdownRender | included content/error UI | traversal/protocol | no reread | MD-EXT-6 | MD-EXT-7 |
| Resource physical reads | server paths/resource route tests | none | authenticated fetch | symlink/race/auth/type/UTF8 | settled HTML | MD-EXT-6 | MD-EXT-7 |
| Include source context | expansion/wiki tests | reader source forwarding | links/images/WikiLinks | no global source | final anchors | MD-EXT-6 | MD-EXT-7 |
| Cycle/depth/size | resource expander tests | error state | safe local placeholder | amplification/no disclosure | export survives | MD-EXT-6 | MD-EXT-7 |
| Mermaid/MarkMap/math | existing tests | existing mount tests | current specs | exact data policy | existing PDF | MD-EXT-0 | every phase |
| Existing Shiki runtime | shiki.test.ts | none | theme/security specs | one singleton/CSS owner | H8 PDF | MD-EXT-0 | every phase |

## 29. Cross-Phase PDF Matrix

| Surface | Required proof | Owning phase | Existing integration point |
| --- | --- | --- | --- |
| Heading IDs/permalinks | Every internal target exists after clone | MD-EXT-1 | pdfExport.ts clone/articleHtml |
| TOC | Static printable list and hrefs match final ids | MD-EXT-1 | PDF stylesheet/clone |
| External links | Safe readable href/text; no reader-only dependency | MD-EXT-1 | pdfExport.ts |
| Lazy images | Images settle and remain included | MD-EXT-1 | pdf-readiness.ts and image wait |
| Containers/details | Printable light styles, deterministic open state | MD-EXT-2 | PDF_DOWNLOAD_STYLES |
| Shiki annotations | Actual classes and computed light token colors | MD-EXT-3 | pdf-export-shiki.spec.ts |
| Line numbers | Gutter visible, wrapped, not clipped | MD-EXT-4 | pdfExport.ts CSS |
| Code groups | All labels/panels after reader selects any tab | MD-EXT-5 | preparePdfArticleHtml() |
| Snippets/includes | Content already present; no resource reread | MD-EXT-6 | PdfExportSurface + articleHtml |
| Mermaid/MarkMap/math | Existing settled/static output | MD-EXT-0 baseline | pdf-readiness.ts |
| Long lines/oversized blocks | Wrap and split contract remains | MD-EXT-4/5/6 | PDF layout/pagination/stress specs |
| Theme matrix | Light syntax under reader light/dark/forced/OS | MD-EXT-3/7 | pdf-export-shiki.spec.ts |

## 30. Bundle and Performance Plan

### 30.1 MD-EXT-0 baseline

Record the actual npm run build output and inspect dist assets:

- main application chunk;
- VaultView/reader chunk;
- Markdown rendering chunk;
- Shiki runtime;
- current lazy grammar/theme chunks;
- current CSS assets;
- largest chunks, raw/gzip values where Vite reports them;
- existing warnings and hashes.

The evidence must label this PRE-MD-EXT baseline and not compare against the older
pre-Shiki application.

### 30.2 MD-EXT-7 comparison

Compare MD-EXT-0 and final build by logical surface, not only hashes:

| Surface | Evidence |
| --- | --- |
| Main/VaultView | Raw/gzip size and reason for change |
| Markdown parser | No duplicate MarkdownIt instance |
| Shiki | One runtime, no eager all-language catalog |
| Language chunks | Requested grammars remain lazy |
| Theme/CSS | One generated owner plus expected static CSS |
| Code groups | Small DOM enhancement; no tab framework |
| Containers/TOC | No heavyweight dependency unless explicitly approved |
| Resource client | No server filesystem code in browser bundle |
| Server | Resource route is server-only and not bundled client-side |

The target is not zero growth. The required invariants are no accidental eager
inclusion of every grammar, no second highlighter, no repeated grammar loading, no
syntax retokenization on theme switch, no duplicate parser architecture, and no
large dependency introduced only for a narrow feature.

## 31. Rollback Strategy

| Boundary | Independent rollback behavior |
| --- | --- |
| Before MD-EXT-1 | Current H8 Markdown behavior remains active |
| MD-EXT-1 | Revert anchors/TOC/generated link/image changes without touching Shiki |
| MD-EXT-2 | Remove colon containers while retaining IDs/links/images |
| MD-EXT-3 | Remove annotations/fence metadata activation while retaining H8 Shiki |
| MD-EXT-4 | Remove line-number transform/CSS only |
| MD-EXT-5 | Remove code-group parser/mount/PDF expansion only |
| MD-EXT-6 | Remove resource endpoint/preprocessor/options while retaining static extensions |
| MD-EXT-7 | No feature rollback; return to last phase-complete release candidate |

Each phase is normally one reviewable implementation commit plus narrowly justified
follow-up fixes. Every evidence document records phase base SHA, previous completion
SHA, validation, scope diff, and next phase. No phase claims its own unknown future
commit before that commit exists.

## 32. Evidence and Documentation Strategy

Create one evidence document per phase. MD-EXT-0 is now recorded; later evidence
documents are created by their owning implementation phase:

~~~text
docs/design/vitepress-markdown-extensions-md-ext-0-audit.md
docs/design/vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md
docs/design/vitepress-markdown-extensions-md-ext-2-containers.md
docs/design/vitepress-markdown-extensions-md-ext-3-code-annotations.md
docs/design/vitepress-markdown-extensions-md-ext-4-line-numbers.md
docs/design/vitepress-markdown-extensions-md-ext-5-code-groups.md
docs/design/vitepress-markdown-extensions-md-ext-6-resources.md
docs/design/vitepress-markdown-extensions-md-ext-7-release-gate.md
~~~

Every evidence file records:

- phase status and exact phase base/completion SHA;
- previous phase completion SHA;
- implementation baseline;
- changed files and forbidden-scope audit;
- exact commands, exit codes, counts, warnings, and environment limitations;
- focused tests and manual/browser/PDF evidence;
- sanitizer/security delta;
- rollback status and next phase.

An evidence document may record a failure as FAIL or BLOCKED. It must not turn a
failed command into PASS by labeling it “known” without evidence. Environment limits
are recorded separately from product failures.

## 33. Program Definition of Done

The program can be declared complete only when MD-EXT-7 proves:

### Product behavior

- custom anchors are narrow, safe, visible suffixes are consumed, and duplicates are
  deterministic;
- [[toc]] uses final IDs, h2-h4 default hierarchy, safe text, and no extra resolver;
- automatic anchors/page-nav/internal Nuvyn links/WikiLinks/.md links remain correct;
- generated Markdown/linkify HTTP(S) links use target=_blank and
  rel=noopener noreferrer; raw HTML anchors retain existing behavior;
- generated Markdown images use loading=lazy without changing URI policy or PDF
  readiness;
- built-in containers and existing callouts coexist with deterministic nesting;
- approved annotations and focus:N work; highlight:N remains deferred;
- annotation HTML is class-based and does not emit Markdown-derived inline style;
- line numbers are opt-in, bounded, structural, accessible, copy-safe where practical,
  and printable;
- code groups are static, accessible, independently interactive, cleaned up, and
  export all panels;
- approved snippets/includes enforce auth, root confinement, symlink/race safety,
  UTF-8/type/size/depth/cycle/error rules and source-context rebasing;
- included headings and final fences participate in the one final render;
- deferred features do not block the initial release.

### Architecture and security

- one MarkdownIt singleton;
- one Shiki highlighter and one style transformer/CSS owner;
- CSS-only theme switching;
- exact Mermaid/MarkMap/math lifecycle;
- DOMPurify remains strict with FORBID_ATTR: ['style'];
- no scripts/events/dangerous URI/arbitrary data/generic attrs/Vue directives;
- physical resource resolver never receives raw dot segments;
- no path escape, symlink escape, SSRF, binary lossy decode, cycle amplification, or
  error disclosure;
- no module-global current source/resource/include/heading/group state.

### Reader, accessibility, and PDF

- system/forced theme matrix remains correct;
- TOC, anchors, details, line-number, and code-group focus/keyboard behavior passes;
- severity/diff annotations remain distinguishable without color alone where practical;
- PDF is printable light under every reader state;
- PDF proves actual nested token colors and exports all approved extension content;
- existing images, Mermaid, MarkMap, math, wrapping, pagination, and stress behavior
  remains intact.

### Verification and release hygiene

- package scripts typecheck, unit, integration, build, and approved browser/PDF tests
  pass;
- bundle audit proves lazy grammars, one runtime/parser, no server-code leakage, and
  no unjustified dependency;
- evidence docs and docs index are complete;
- deferred/rejected features remain absent;
- Shiki H0-H8 remains closed and no H9 is created.

## 34. Deferred Features

| Feature | Status | Required action to revisit |
| --- | --- | --- |
| [!code highlight:N] | DEFERRED | PRD review and explicit transformer/range contract |
| Heading/section include | DEFERRED | Source-context, final-heading, range/error contract review |
| Code-file inclusion inside fences | DEFERRED | Explicit syntax/product approval and same safe resolver |
| Arbitrary custom container registration | DEFERRED | Typed safe configuration design and bundle/security review |
| Generic attrs | REJECTED | Product/security contract change required |
| ::: raw | REJECTED | Sanitizer contract change required |
| Vue-in-Markdown | REJECTED | Runtime/security architecture change required |
| VitePress routing/page suffix | REJECTED | Nuvyn router/product change required |
| Remote resources | REJECTED | SSRF/network policy change required |

Deferred features are OUT OF RELEASE SCOPE, not failed tests. They must not be
implemented opportunistically in a phase that owns a related feature.

## 35. Risks and Stop Conditions

| Stop condition | Required response |
| --- | --- |
| PRD/product semantics conflict | Stop implementation and review PRD |
| Custom anchors require generic attrs | Stop and redesign |
| TOC needs a second slugger or HTML reparse | Stop |
| Link policy overwrites wikiLinkPlugin or rewrites raw HTML | Stop and compose renderer |
| Transformer order requires a second style transformer or inline style | Stop |
| highlight:N appears enabled accidentally | Stop; keep deferred or review PRD |
| Line numbers require inline/dynamic user CSS | Stop and redesign |
| Code groups require Vue compilation inside v-html | Stop |
| PDF exports only the active code-group tab | Stop |
| Resource endpoint cannot prove auth/root/symlink confinement | Stop |
| Physical resolver must accept raw .. or backslash | Stop |
| Included source context requires global mutable state | Stop |
| Resource expansion duplicates WikiResolver calls without a bounded contract | Stop |
| Resource processing occurs after Shiki discovery | Stop |
| Binary/invalid text is decoded lossily | Stop |
| Resource errors disclose host paths or stack traces | Stop |
| A second Shiki/MarkdownIt instance appears in bundle | Stop |
| Existing Mermaid/MarkMap/math/PDF contract regresses | Stop at owning phase |
| Release gate finds a real product failure | Block; fix owning phase separately |

The implementation plan remains the execution map. SHIKI-H0 through SHIKI-H8
are complete / closed. MD-EXT-0 through MD-EXT-6 are implemented and
review-closed with their evidence documents. MD-EXT-7 is COMPLETE / REVIEW-CLOSED,
the release gate is PASS, and the MD-EXT PROGRAM is COMPLETE / REVIEW-CLOSED.
There is no H9 or MD-EXT-8 phase in this program.
