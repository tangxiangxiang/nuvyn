# Nuvyn VitePress-Style Markdown Extensions PRD

## 1. Document Information

| Field | Value |
| --- | --- |
| Document status | PROPOSED / PRODUCT CONTRACT — implementation not started |
| Product program | Nuvyn VitePress-Style Markdown Extensions |
| Repository | `tangxiangxiang/nuvyn` |
| Branch | `main` |
| Baseline HEAD | `c32f5bc9c1597c6c2f6b3e9581f327636fe8d8c2` |
| Shiki migration state | SHIKI-H0 through SHIKI-H8 COMPLETE; migration closed; no H9 |
| Primary reference | [VitePress Markdown Extensions](https://vitepress.dev/guide/markdown.html) |
| VitePress reference version observed | `2.0.0-alpha.19` |
| VitePress reference checked | `2026-08-21` |
| Shiki reference | [Shiki `@shikijs/transformers`](https://shiki.style/packages/transformers) |
| Current parser | `markdown-it` 14.x singleton |
| Current highlighter | Shiki 4.4.x, class-based, dual-theme, lazy languages |
| Security invariant | `FORBID_ATTR: ['style']` remains mandatory |
| Scope | Product requirements and compatibility boundaries only |
| Out of scope for this task | Implementation plan, plugins, dependencies, tests, source changes |

This document is the authoritative product contract for a future Markdown-extension
program. It does not authorize implementation work by itself. A later implementation
plan must consume this document and must stop for product review if the repository or
implementation proposal conflicts with any security, routing, rendering, or PDF
requirement here.

## 2. Executive Summary

Nuvyn already has a useful Markdown surface: CommonMark/MarkdownIt behavior, frontmatter,
heading anchors, task lists, footnotes, definition lists, mark syntax, WikiLinks,
callouts, math, emoji, Mermaid, MarkMap, and the completed Shiki pipeline. Authors can
use Nuvyn as a knowledge-base reader today, but several familiar VitePress authoring
patterns are missing or have different semantics.

This program adds the highest-value VitePress-style syntax without importing VitePress's
static-site runtime, Vue-in-Markdown compiler, router, page-suffix conventions, or
security assumptions. The intended result is syntax familiarity and practical visible
behavior, not byte-for-byte VitePress HTML.

The recommended scope is:

- P0: custom heading anchors, a Markdown `[[toc]]` directive, Nuvyn external-link
  treatment, lazy image loading, built-in custom containers, and Shiki code annotations.
- P1: opt-in line numbers and accessible code groups.
- P2: safe vault-relative code snippets and Markdown includes, subject to a new safe
  resource boundary and explicit product limits.
- Deferred or rejected: arbitrary Markdown attributes, `::: raw` sanitizer bypass,
  VitePress routing/page suffixes, Vue execution in Markdown, remote resources, and
  arbitrary filesystem access.

The existing Shiki H0-H8 migration is a frozen dependency and architecture baseline,
not a phase of this program. No new highlighter, parser, or theme lifecycle is proposed.

## 3. Problem

### 3.1 Authoring gap

Authors familiar with VitePress expect a small set of portable Markdown idioms:

````markdown
# Java Guide {#java-guide}

[[toc]]

::: tip
Important note
:::

```ts {1,3-5}
const value = 1
```
````

Nuvyn currently handles some of the surrounding concepts but not these exact forms.
The absence of a deliberate compatibility contract creates two risks:

1. future features may be implemented inconsistently, with each feature inventing its
   own metadata, resource, or heading rules;
2. a compatibility feature may accidentally weaken DOMPurify, duplicate the Shiki
   runtime, bypass Nuvyn vault routing, or make PDF output dependent on reader state.

### 3.2 Compatibility boundary

VitePress is a static-site generator. For this compatibility work, Nuvyn's relevant
surface is an interactive, self-hosted vault reader with runtime Markdown rendering,
authenticated server APIs, a vault path model, Vue components mounted after `v-html`,
and printable PDF cloning. Syntax can be compatible while runtime and build semantics
remain intentionally different.

This PRD therefore defines compatibility in this order:

1. author-facing Markdown syntax;
2. useful visible behavior;
3. Nuvyn security invariants;
4. Nuvyn vault/router/runtime architecture;
5. generated HTML details.

If exact VitePress output conflicts with Nuvyn security or runtime constraints, Nuvyn's
security and runtime model wins.

## 4. Goals

The program must:

1. add high-value VitePress-style syntax with a narrow, documented grammar;
2. preserve all existing Nuvyn Markdown behavior and routing semantics;
3. keep the completed Shiki runtime, transformer, CSS owner, lazy loading, and PDF light
   palette unchanged as architectural constraints;
4. make headings, TOC entries, custom anchors, and included content share one final
   heading-ID/token model;
5. make every interactive extension safe when rendered through Vue `v-html`;
6. define deterministic reader, theme, accessibility, and PDF behavior for each feature;
7. make future snippet/include support vault-confined, size-limited, cycle-safe, and
   independent of arbitrary host filesystem or network access;
8. keep Markdown rendering async only where resource or Shiki preparation requires it,
   without replacing MarkdownIt with an async parser;
9. provide a later test matrix that covers security, resolver isolation, browser behavior,
   and PDF output;
10. make deferred and rejected features explicit so parity pressure cannot silently
    expand scope.

## 5. Non-Goals

This program does not implement or plan the following as part of the initial contract:

- the full VitePress runtime, default theme, or build system;
- VitePress SPA routing, `.html` page suffixes, or `index.md` route rewriting;
- Vue components, Vue directives, `script setup`, or arbitrary client JavaScript in
  Markdown;
- arbitrary JavaScript execution, live playgrounds, code execution, Twoslash, or Monaco;
- arbitrary Markdown plugin installation by note authors;
- a general-purpose attributes plugin;
- arbitrary Markdown `style` attributes or any CSS injection feature;
- a `::: raw` container that bypasses DOMPurify or creates a trusted HTML island;
- user-selectable Shiki themes;
- another Shiki highlighter instance or another Shiki Markdown integration package;
- a Markdown parser replacement or `markdown-it-async` solely for these extensions;
- line folding or a copy-code button unless separately approved;
- network includes, remote snippet imports, or arbitrary URL resources;
- arbitrary host filesystem access;
- regression or redesign of MarkMap, Mermaid, math, PDF export, or the completed Shiki
  migration outside the explicit compatibility work described here.

## 6. Current Nuvyn Markdown Baseline

### 6.1 Rendering pipeline

The current production flow is:

```text
raw post source
    ↓
parseDoc() in src/lib/frontmatter.ts
    ↓
useMarkdownRender() in src/composables/vault/useMarkdownRender.ts
    ↓
render() in src/lib/markdown.ts
    ↓
getMd() → one MarkdownIt 14.x singleton
    ↓
md.parse(markdown, isolated discovery env)
    ↓
prepareShikiLanguages() for eligible normal fences
    ↓
md.render(markdown, fresh real WikiLink env)
    ↓
Shiki normal fences / MarkMap placeholder / Mermaid placeholder / math placeholder
    ↓
syncGeneratedShikiStylesheet()
    ↓
DOMPurify with the Nuvyn allowlist
    ↓
RenderedMarkdown → v-html
    ↓
post-render Mermaid, MarkMap, and math mounting where applicable
```

`render()` remains `Promise<string>`. MarkdownIt itself remains synchronous after
preparation. The final HTML is sanitized before it reaches `v-html`.

### 6.2 Existing Markdown features

The repository currently provides the following behavior, which this program must
protect from regression:

| Area | Current Nuvyn implementation | Status for this program |
| --- | --- | --- |
| CommonMark / MarkdownIt | `new MarkdownIt({ html: true, linkify: true, typographer: true })` in `src/lib/markdown.ts` | Preserve |
| Frontmatter | YAML parsing in `src/lib/frontmatter.ts`; server also uses `gray-matter` for post reads | Existing |
| Heading anchors | `markdown-it-anchor` with Nuvyn slugification and header permalink | Existing; extend safely |
| Task lists | `markdown-it-task-lists` | Existing |
| Footnotes | `markdown-it-footnote` | Existing |
| Definition lists | `markdown-it-deflist` | Existing |
| Mark syntax | `markdown-it-mark`, `==text==` | Existing |
| Tables | MarkdownIt table rule plus Nuvyn `.table-scroll` wrapper | Existing |
| WikiLinks | `wikiLinkPlugin`, render-scoped resolver, `/vault/` links | Existing Nuvyn routing |
| `.md` links | Classified by the WikiLink plugin and resolver | Existing Nuvyn routing |
| Callouts | `calloutPlugin`, blockquote `[!TYPE]` syntax and aliases | Existing; do not replace |
| Math | `mathPlugin` placeholders mounted by the math lifecycle | Existing |
| Emoji | `@mdit/plugin-emoji` with Nuvyn emoji definitions | Existing |
| Mermaid | Exact `mermaid` fence → encoded `.mermaid-mount` placeholder | Existing special fence |
| MarkMap | Exact `markmap` fence → encoded `.markmap-mount` placeholder | Existing special fence |
| Syntax highlighting | Shiki 4.4.x, `github-light` + `github-dark`, lazy languages, class-based CSS | Existing; frozen |
| PDF export | `src/lib/pdfExport.ts` clone/readiness/light printable surface | Existing; extend deliberately |

### 6.3 Security baseline

`src/lib/markdown.ts` enables semantic raw HTML for Markdown compatibility, then applies
DOMPurify. The current configuration includes a narrow tag/attribute allowlist,
`ALLOW_DATA_ATTR: true` followed by a hook that keeps only Nuvyn-owned data attributes,
event-handler removal, URI filtering, forbidden tags, and:

```ts
FORBID_ATTR: ['style']
```

The program must preserve this invariant. The currently retained data attributes are
`data-anchor`, `data-content`, `data-missing`, and `data-target`. New features may add
only feature-specific tags/attributes after an explicit security review.

### 6.4 Heading and page navigation baseline

`markdown-it-anchor` owns heading IDs and permalink markup. `useMarkdownRender.ts`
re-reads rendered HTML to derive the reader's h2-h4 page navigation; it does not run a
second slugification algorithm. The future `[[toc]]` feature must use the same final
heading IDs rather than creating a parallel slugger.

### 6.5 Shiki H8 baseline

The completed Shiki migration is recorded in:

- `docs/design/syntax-highlighting-shiki-migration-prd.md`;
- `docs/design/syntax-highlighting-shiki-migration-implementation-plan.md`;
- `docs/design/syntax-highlighting-shiki-h8-release-gate.md`.

The following are frozen:

- one long-lived Shiki highlighter in `src/lib/shiki.ts`;
- one `transformerStyleToClass` instance;
- class-based `nuvyn-shiki-*` token output;
- one trusted generated stylesheet owner, `style#nuvyn-shiki-generated-styles`;
- lazy language loading and escaped unknown-language fallback;
- exact MarkMap and Mermaid bypass behavior;
- CSS-only reader theme switching;
- printable-light PDF syntax colors;
- no Shiki inline token styles in sanitized Markdown HTML.

### 6.6 Resource/API baseline

The current authenticated client API reads posts through `/api/posts/*`. The server
route uses `filePathFor()` and therefore resolves Nuvyn notes as vault-relative `.md`
files. `server/paths.ts` also contains security-oriented generic helpers such as
`resolveSafeRelativePathDetailed()` and `readSafeRelativeFile()`, including symlink and
resource checks, but there is no current public Markdown resource endpoint for arbitrary
code files or include expansion.

Therefore snippet/import and Markdown-include support cannot be assumed to work by
calling the existing post API. They require a later, explicit, authenticated resource
boundary that reuses the server path-security model.

### 6.7 Reader, mount, and PDF baseline

`RenderedMarkdown.vue` inserts the sanitized article through `v-html` and then exposes
the article element to the existing Mermaid, MarkMap, and math mount paths. This is why
future interactive Markdown features must use a post-render enhancement/lifecycle
rather than Vue directives inside Markdown HTML.

`PdfExportSurface.vue` renders a hidden, real layout surface with
`render-theme="light"` so mountable diagrams can settle in a printable context. That
prop is consumed by the render/mount path; it is not a global mutation of
`document.documentElement[data-theme]`. `src/lib/pdfExport.ts` then clones settled
content, staticizes Mermaid/MarkMap, injects a trusted Shiki light snapshot, and applies
`.pdf-document` rules for wrapping, pagination, and printable token colors. Future
extensions must add to this clone/staticization contract rather than rereading vault
resources or using the reader's active tab/theme.

The H8 release gate and its browser/PDF evidence are the current proof point for Shiki
token colors, reader theme switching, security, Mermaid/MarkMap compatibility, and
printable-light PDF behavior.

## 7. VitePress Compatibility Philosophy

The compatibility review is pinned to the official [VitePress Markdown Extensions page](https://vitepress.dev/guide/markdown.html)
as observed in VitePress `2.0.0-alpha.19` on `2026-08-21`, not to VitePress's internal
source code. It documents author-facing forms including
custom anchors, containers and nesting, GitHub alerts, Shiki annotations, line numbers,
snippets, code groups, Markdown inclusion, math, lazy images, and advanced Markdown
configuration.

Nuvyn targets:

- familiar syntax where it is useful;
- equivalent author-visible intent where Nuvyn routing or security differs;
- deterministic output across reader and PDF surfaces;
- explicit safe degradation for malformed or unavailable resources.

Nuvyn does not target:

- compiled Vue components in Markdown;
- VitePress's `.html` route/page model;
- build-time source-root assumptions that expose the host filesystem;
- VitePress's permissive generic attribute surface;
- byte-identical DOM structure or CSS class names.

## 8. Full Compatibility Matrix

The inventory below keeps the 43-item coverage stable while separating where a feature
comes from from what Nuvyn will do with it. `Reference source` is one or more of
`VitePress`, `Shiki`, `Existing Nuvyn`, or `Nuvyn extension candidate`; it is not a
claim that every row is a mandatory VitePress-parity requirement. `EXISTING` means
Nuvyn already provides the behavior and it must be preserved. `ADD` means a new Nuvyn
feature is recommended. `ADAPT` means the author syntax or intent is useful but must
use Nuvyn routing, runtime, or security semantics. `DEFER` means it is not in the
initial program. `REJECT` means the initial product must not provide the feature under
its VitePress meaning.

| # | Feature / syntax | Reference source | Classification | Nuvyn decision |
| ---: | --- | --- | --- | --- |
| 1 | Automatic heading anchors | VitePress / Existing Nuvyn | EXISTING | Keep `markdown-it-anchor` and the current slug/permalink behavior. |
| 2 | Custom heading anchors | VitePress | ADD | Add narrow `{#id}` syntax with safe IDs and final-ID deduplication. |
| 3 | Internal links | VitePress / Existing Nuvyn | ADAPT | Keep vault-aware WikiLink and `.md` resolution; do not use VitePress router links. |
| 4 | Page suffix behavior | VitePress | REJECT | `.html` page suffixes and `index.md` route rewriting do not fit Nuvyn. |
| 5 | External links | VitePress | ADD | Add Nuvyn-owned `target="_blank"` and `rel="noopener noreferrer"` treatment for generated HTTP(S) links. |
| 6 | Frontmatter | VitePress / Existing Nuvyn | EXISTING | Preserve YAML parsing and Nuvyn metadata/title semantics. |
| 7 | GitHub-style tables | VitePress / Existing Nuvyn | EXISTING | Preserve MarkdownIt tables and `.table-scroll`. |
| 8 | Task lists | VitePress / Existing Nuvyn | EXISTING | Preserve `markdown-it-task-lists` behavior. |
| 9 | Footnotes | VitePress / Existing Nuvyn | EXISTING | Preserve `markdown-it-footnote` behavior and sanitized anchors. |
| 10 | Emoji | VitePress / Existing Nuvyn | EXISTING | Preserve Nuvyn emoji definitions and shortcodes. |
| 11 | `[[toc]]` | VitePress | ADD | Add a standalone directive based on the final heading token/ID model. |
| 12 | Custom containers | VitePress | ADD | Add built-in `info`, `tip`, `warning`, `danger`, and `details`. |
| 13 | Custom container titles | VitePress | ADD | Support safe plain-text titles, including `::: danger STOP`. |
| 14 | Custom container registration | VitePress | DEFER | No public arbitrary Markdown plugin/configuration API in v1. |
| 15 | Nested containers | VitePress | ADD | Support longer outer fences using MarkdownIt fence-matching rules. |
| 16 | Container additional attributes | VitePress-inspired / Nuvyn narrow extension candidate | REJECT | Reject broad attrs; a narrow `details {open}` token may be approved separately and is not generic attribute support. |
| 17 | `::: raw` | VitePress | REJECT | It must not become a DOMPurify or style-policy bypass. |
| 18 | GitHub-flavored alerts | VitePress / Existing Nuvyn | EXISTING | Preserve Nuvyn callouts, aliases, titles, and blockquote behavior. |
| 19 | Shiki syntax highlighting | VitePress / Shiki / Existing Nuvyn | EXISTING | Preserve the H8 Shiki pipeline; do not add another integration. |
| 20 | Code-line metadata highlighting | VitePress / Shiki | ADD | Add VitePress-style fence ranges such as `{1,3-5}`. |
| 21 | `[!code highlight]` | VitePress / Shiki | ADD | Use the official Shiki notation transformer and Nuvyn CSS. |
| 22 | `[!code focus]` | VitePress / Shiki | ADD | Use official focus classes; keep theme switching CSS-only. |
| 23 | `[!code ++]` / `[!code --]` | VitePress / Shiki | ADD | Use official diff classes and printable-light PDF styles. |
| 24 | `[!code warning]` / `[!code error]` | VitePress / Shiki | ADD | Use official error-level classes with non-color cues where practical. |
| 25 | `[!code info]` | Shiki / Nuvyn extension candidate | ADD | Expose as a Nuvyn extension aligned with the installed official transformer; it is not a VitePress page-parity requirement. |
| 26 | Line numbers | VitePress | ADD | Opt-in per fence, default OFF, no inline styles, custom starting value. |
| 27 | Custom line-number starting value | VitePress | ADD | Support `:line-numbers=N` in the unified metadata grammar. |
| 28 | Code snippet imports | VitePress / Nuvyn adaptation | ADAPT | Use a future authenticated vault/resource resolver, not browser filesystem access. |
| 29 | Snippet regions | VitePress / Nuvyn adaptation | ADAPT | Support a controlled region grammar only if the safe resource boundary ships. |
| 30 | Snippet line ranges | VitePress / Nuvyn adaptation | ADAPT | Support bounded ranges after safe file resolution. |
| 31 | Explicit snippet language | VitePress / Nuvyn adaptation | ADAPT | Allow a safe explicit language token in snippet metadata. |
| 32 | Code groups | VitePress | ADD | Add accessible post-`v-html` enhancement and deterministic PDF expansion. |
| 33 | Snippets inside code groups | VitePress / Nuvyn adaptation | ADAPT | Reuse the safe snippet resolver; do not duplicate file reads. |
| 34 | Markdown file inclusion | VitePress / Nuvyn adaptation | ADAPT | Expand from vault resources before final heading/fence discovery. |
| 35 | Nested Markdown inclusion | VitePress / Nuvyn adaptation | ADAPT | Add cycle/depth/size limits and source-path context. |
| 36 | Include line ranges | VitePress / Nuvyn adaptation | ADAPT | Support bounded line selection after safe include resolution. |
| 37 | Include heading/section selection | VitePress syntax / Nuvyn extension candidate | DEFER | Keep it out of the initial MD-EXT-6 core until heading-section semantics and source context are separately approved. |
| 38 | Relative URL/image rebasing in included Markdown | VitePress / Nuvyn adaptation | ADAPT | Resolve relative resources against the included file's directory. |
| 39 | Code-file inclusion inside fences | VitePress syntax / Nuvyn extension candidate | DEFER | Keep it as a later candidate; initial MD-EXT-6 does not require it to ship. |
| 40 | Math | VitePress / Existing Nuvyn | EXISTING | Preserve Nuvyn KaTeX/math placeholders and mount behavior. |
| 41 | Image lazy loading | VitePress | ADD | Add `loading="lazy"` without broadening URL or attribute policy. |
| 42 | Advanced Markdown configuration | VitePress / Nuvyn adaptation | ADAPT | Offer only Nuvyn-owned, typed, feature-specific configuration; no arbitrary plugins from notes. |
| 43 | VitePress runtime/build-system compatibility | VitePress | REJECT | This program is syntax/behavior compatibility, not VitePress embedding. |

The table deliberately separates `container additional attributes` from the narrow
potential `details {open}` decision. A feature-specific, allowlisted token is not a
general attributes plugin and requires product approval before implementation.

## 9. Product Scope & Priorities

| Priority | Features | Release meaning |
| --- | --- | --- |
| P0 | Custom anchors, `[[toc]]`, external-link treatment, lazy images, built-in containers, Shiki annotations | Core authoring compatibility and high-value visual improvements. |
| P1 | Line numbers, code groups | Valuable reader/PDF features requiring structural HTML and interaction work. |
| P2 | Safe snippets, Markdown includes, nested/resource variants | Advanced resource features requiring a new server boundary and more threat modeling. Heading/section selection and code-file inclusion inside fences remain deferred candidates unless separately approved. |
| DEFER | Arbitrary custom container registration, unresolved include-section variants, optional advanced metadata not approved | Do not block P0/P1 release. |
| REJECT | Generic attrs, `::: raw` bypass, VitePress routing/page suffixes, Vue-in-Markdown, remote resources, arbitrary filesystem | Explicitly outside the product contract. |

Deferred features must not be implemented opportunistically. A later scope change must
update this PRD before an implementation plan is changed.

## 10. Heading Anchors

### 10.1 Existing behavior

Automatic heading IDs and permalink markup remain owned by `markdown-it-anchor`.
Custom anchors must integrate at the token or heading-content level before the final
renderer emits the heading. They must not introduce a second slugifier.

### 10.2 Custom syntax

Target syntax:

```markdown
# Java Guide {#java-guide}
```

Required behavior:

- `{#java-guide}` is consumed as metadata and is not visible in heading text;
- the explicit ID replaces the automatic slug for that heading;
- the permalink anchor, reader page navigation, `[[toc]]`, and PDF all use the final ID;
- duplicate final IDs are resolved deterministically within one expanded document;
- the recommended duplicate rule is first occurrence keeps the requested ID and later
  occurrences receive `-2`, `-3`, and so on;
- an ID already generated by another heading participates in the same deduplication set;
- malformed or invalid syntax is treated as ordinary visible heading text, without
  partially consuming metadata or creating an unsafe attribute;
- custom anchor parsing is restricted to a feature-specific suffix, not generic
  attributes.

### 10.3 Recommended safe grammar

The initial grammar should accept a conservative ASCII fragment identifier:

```text
{#<id>}
<id> := [A-Za-z][A-Za-z0-9._:-]{0,127}
```

The implementation may choose a stricter subset after testing. It must reject spaces,
quotes, braces, control characters, HTML syntax, URI schemes, and arbitrary attribute
text. CJK heading text remains supported by automatic slugification; custom IDs are
conservative to keep links portable and security review simple.

The parser must not enable syntax such as:

```markdown
# Unsafe {style="color:red" onclick="..." class="user-class"}
```

## 11. Table of Contents

### 11.1 Syntax and recognition

Target syntax:

```markdown
[[toc]]
```

The directive is recognized only when it is the intended standalone block directive:
the trimmed block contains exactly `[[toc]]`, with case-sensitive spelling for the
initial release. Inline `[[toc]]` text, code spans, fenced code, and text containing
additional prose remain ordinary Markdown/WikiLink content.

### 11.2 Heading source and default depth

The recommended initial default is h2 through h4. This matches the existing Nuvyn
reader page-navigation levels, keeps the document title out of the TOC, and avoids a
long TOC for deeply nested implementation headings. A later configurable range may be
added through a typed Nuvyn option; the first implementation must not introduce a
second slugification or heading pass.

The TOC must be generated from the final heading token/ID stream after custom-anchor
processing and, once includes exist, after include expansion. It must:

- use the exact final `id` values;
- include duplicate headings with their deduplicated IDs;
- produce safe readable text when headings contain inline HTML or Markdown formatting;
- preserve a nested list hierarchy by heading level;
- use a semantic navigation/list structure appropriate for sanitized reader HTML;
- not invoke the WikiLink resolver while collecting headings;
- work in reader and PDF surfaces;
- remain safe if no eligible heading exists, preferably rendering an empty/omitted TOC
  rather than an error block.

The current `useMarkdownRender` heading extraction is evidence that the app already has
a final-HTML page-nav path. The future TOC should share the final heading model, not
copy its regex into another independent slug/ID implementation.

## 12. Link Behavior

### 12.1 Internal Nuvyn links

Nuvyn-owned behavior remains authoritative for:

- `[[target]]`, aliases, and heading fragments;
- standard Markdown links to vault `.md` paths;
- relative note navigation;
- `/vault/` path construction;
- missing-link state and `data-target`/`data-missing` attributes;
- render-scoped WikiLink resolver isolation.

Internal links must not be converted to VitePress router links, `index.html` routes, or
`.html` page-suffix URLs. A future implementation may add anchor normalization, but it
must preserve the Nuvyn vault path model.

### 12.2 External links

The initial MD-EXT external-link policy applies only to links generated by Nuvyn's
Markdown renderer. This includes explicit Markdown links and MarkdownIt `linkify` output:

```markdown
[OpenAI](https://openai.com)
https://openai.com
```

For generated external HTTP(S) links, Nuvyn must emit:

```html
<a href="https://example.com" target="_blank" rel="noopener noreferrer">
```

This is an approved product contract, not an open decision. `noopener` isolates the
new window from `window.opener`; `noreferrer` also limits referrer disclosure. The
generated values are policy-owned and cannot be weakened by Markdown input or by
author-supplied link metadata.

The policy does not silently redesign raw semantic HTML links. For example:

```html
<a href="https://example.com" target="_self">Example</a>
```

continues through the existing DOMPurify/security contract. MD-EXT-1 must not rewrite
every raw `<a>` in final sanitized HTML merely because it has an HTTP(S) `href`.

The external classification is:

- external-policy targets: `http:` and `https:` links that are not Nuvyn-owned
  vault/internal routes;
- not external-policy targets: `mailto:`, `tel:`, `#fragment`, relative paths,
  `./`, `../`, `/vault/...`, WikiLinks, and Nuvyn `.md` links.

The existing URI policy remains in force for every link surface.

## 13. Image Lazy Loading

Normal Markdown images should receive `loading="lazy"` when the renderer can add it
without changing the user-authored URL or broadening the sanitizer allowlist.

Requirements:

- existing `src`, `alt`, width, height, and URI validation behavior remains unchanged;
- no arbitrary image attributes are accepted;
- already-loaded or required images in PDF are still awaited by `pdf-readiness`;
- the reader must not reserve a broken layout solely because lazy loading is added;
- PDF output must contain the image and must not depend on the image having been visible
  in the reader first;
- images explicitly handled by Mermaid/MarkMap remain owned by those lifecycles.

The current sanitizer already allows `loading`, so the preferred implementation is no
new broad allowlist entry. Any extra attribute must be justified individually.

## 14. Custom Containers

### 14.1 Built-in syntax

The initial built-in set is:

```markdown
::: info
Informational content.
:::

::: tip
Helpful content.
:::

::: warning
Use caution.
:::

::: danger STOP
Danger-zone content.
:::

::: details Click me
Hidden until opened.
:::
```

The exact Nuvyn-owned classes must be selected in implementation planning, but the
structural contract is:

- `info`, `tip`, `warning`, and `danger` render as safe block containers with a
  Nuvyn-owned type class and an escaped/rendered title;
- `details` renders semantic `<details><summary>…</summary>…</details>`;
- titles are content, not raw HTML or attribute strings;
- the body is normal Markdown and may contain existing callouts, math, links, and code
  where MarkdownIt nesting permits;
- no container emits an inline `style` attribute;
- unknown container types fail safely as ordinary Markdown or a visible, non-executable
  fallback according to the later parser design; they never select arbitrary CSS or
  components.

### 14.2 Titles and narrow details option

`::: danger STOP` and `::: details Click me` use the first title token as visible title.
The recommended initial title grammar is escaped plain text with normal inline Markdown
only if the implementation can preserve the sanitizer boundary.

The product may approve `::: details Example {open}` as a narrow feature-specific
modifier that maps only to the boolean `open` attribute. It must not activate generic
attribute parsing. If not approved, `{open}` remains visible content or causes safe
fallback according to the malformed-syntax policy.

### 14.3 Nested containers

Use MarkdownIt-style matching-fence semantics. A nested container is valid when the
outer delimiter is longer than the inner delimiter:

```markdown
:::: info Outer

::: details Inner
Nested content.
:::

::::
```

An inner close marker must not accidentally close an outer container. Unclosed or
ambiguous containers must fail deterministically without swallowing the rest of the
document where practical.

## 15. Existing Callouts Compatibility

Nuvyn's blockquote callouts remain a separate, supported syntax:

```markdown
> [!NOTE]
> Existing callout content.
```

The current `CALLOUT_TYPES` and aliases in `src/lib/callouts.ts` remain authoritative.
The new colon containers must not replace or normalize the existing callout classes,
titles, body handling, or ordinary blockquotes.

The parser must allow callouts and containers to coexist and nest where MarkdownIt
semantics are unambiguous. A container parser must not reinterpret a blockquote marker
or strip a callout marker before `calloutPlugin` sees it. Tests must cover container
inside callout, callout inside container, and ordinary blockquote behavior.

## 16. Shiki Code Annotations

### 16.1 Supported annotation family

The P0/P1 code annotation family is:

````markdown
```ts {1,3-5}
const a = 1
const b = 2
const c = 3
const d = 4
const e = 5
```

```ts
const before = 1 // [!code --]
const after = 2  // [!code ++]
warn()            // [!code warning]
fail()            // [!code error]
info()            // [!code info]
focus()           // [!code focus]
const first = 1  // [!code focus:3]
const second = 2
const third = 3
```
````

The implementation should reuse official `@shikijs/transformers` capabilities where
they match the contract:

- `transformerMetaHighlight` for fence metadata ranges;
- `transformerNotationHighlight` for `[!code highlight]`;
- `transformerNotationFocus` for `[!code focus]`;
- `transformerNotationDiff` for `[!code ++]` and `[!code --]`;
- `transformerNotationErrorLevel` for error, warning, and info levels;
- `transformerStyleToClass` for the existing trusted token-color CSS path.

The official transformer package documents these as class-producing, unstyled
transformers. Nuvyn CSS owns visuals; no annotation may introduce inline styles.

### 16.2 HTML contract

The conceptual output is:

```html
<pre class="shiki has-highlighted has-focused has-diff">
  <code>
    <span class="line highlighted">...</span>
    <span class="line focused">...</span>
    <span class="line diff add">...</span>
    <span class="line highlighted warning">...</span>
    <span class="line highlighted error">...</span>
    <span class="line highlighted info">...</span>
  </code>
</pre>
```

Exact official class output takes precedence where practical. Nuvyn may add a stable
outer class only when needed for CSS or PDF. The notation marker's visibility/removal
must be frozen during implementation planning; the recommended behavior is to use the
official transformer default and keep the marker out of displayed code when the
transformer removes it.

### 16.2.1 Multi-line notation contract

`[!code focus:N]` is part of the initial VitePress-style authoring contract. `N` means
the annotated line plus the configured following-line span according to the official
Shiki transformer semantics. Nuvyn must delegate that interpretation to the official
transformer rather than maintaining a second count/range implementation.

`[!code highlight:N]` is tracked separately from the approved single-line
`[!code highlight]` form. It is a Shiki-backed Nuvyn extension candidate and is
`DEFER` until the official transformer semantics provide a clean, supported range
behavior. It must not be inferred as focus behavior or become an MD-EXT release
blocker. If separately approved later, it must use official transformer semantics.

For every `:N` form:

- `N` accepts only a positive, bounded integer;
- zero, negative, non-numeric, empty, or absurd values are rejected or safely ignored;
- values beyond the code block never throw and follow the official transformer
  behavior, such as safe clamping/ignoring of out-of-range lines;
- malformed input never creates arbitrary HTML, class names, attributes, or styles;
- the exact finite upper bound is an implementation-plan parameter and must be
  documented before implementation, not an unbounded parser assumption.

### 16.2.2 Annotation matrix

| Syntax | Reference source | Initial scope | Expected transformer/behavior |
| --- | --- | --- | --- |
| `{1,3-5}` | VitePress / Shiki | ADD | `transformerMetaHighlight`; bounded line/range highlighting. |
| `[!code highlight]` | VitePress / Shiki | ADD | `transformerNotationHighlight`; class-based highlighted line. |
| `[!code highlight:N]` | Shiki / Nuvyn extension candidate | DEFER | Only add if an official transformer supports the range semantics cleanly; never reinterpret as focus. |
| `[!code focus]` | VitePress / Shiki | ADD | `transformerNotationFocus`; focus state with CSS-only de-emphasis. |
| `[!code focus:N]` | VitePress / Shiki | ADD | Official focus count semantics for the annotated line and following span. |
| `[!code ++]` | VitePress / Shiki | ADD | `transformerNotationDiff`; printable add state. |
| `[!code --]` | VitePress / Shiki | ADD | `transformerNotationDiff`; printable remove state. |
| `[!code warning]` | VitePress / Shiki | ADD | `transformerNotationErrorLevel`; warning class plus non-color cue where practical. |
| `[!code error]` | VitePress / Shiki | ADD | `transformerNotationErrorLevel`; error class plus non-color cue where practical. |
| `[!code info]` | Shiki / Nuvyn extension candidate | ADD | `transformerNotationErrorLevel`; approved Nuvyn extension, not mandatory VitePress parity. |

### 16.3 Annotation security

Annotations are source-code control syntax. They may change only known structural
classes and line state. They must not:

- create arbitrary class names from source text;
- create arbitrary attributes or data attributes;
- emit HTML, CSS, or scripts;
- change DOMPurify policy;
- alter the Shiki generated stylesheet;
- cause a second highlighter or a second tokenization pass merely for theme changes.

The reader must work in light, dark, forced light, forced dark, and OS-fallback states
with CSS-only visual changes. PDF must retain the annotation semantics in a printable
light palette.

## 17. Fence Metadata Grammar

The program must define one parser for all fence metadata. Later phases must not invent
separate parsers for line highlights, line numbers, labels, snippets, and code groups.

### 17.1 Conceptual grammar

The recommended grammar is:

```text
fence-info := language [modifier]* [range-list]? [label]?
language   := first non-whitespace identifier
modifier   := :line-numbers | :no-line-numbers | :line-numbers=positive-integer
range-list := { item (',' item)* }
item       := positive-integer | positive-integer '-' positive-integer
label      := '[' escaped display text ']'
```

The parser should accept the common forms:

````markdown
```ts {1,3-5}
```ts:line-numbers {1,3-5}
```ts:line-numbers=10 {1,3-5}
```ts [config.ts]
````

It may accept equivalent whitespace/order variants only if ambiguity is not introduced.
Language, number metadata, line ranges, and display label are separate fields in the
parsed representation. Snippet language overrides and future code-group metadata must
reuse those fields.

### 17.2 Malformed metadata

Malformed ranges (`{10-3}`), invalid starts (`:line-numbers=abc`), unmatched brackets,
or unknown modifiers must never crash rendering or produce arbitrary attributes. The
recommended behavior is to ignore the invalid metadata and render a normal safe code
block, while preserving source text when the parser cannot prove that a suffix is
metadata.

`markmap` and `mermaid` remain special only under their exact existing language
identifier contract. `mermaid{1}` and `markmap{1}` must not silently become normal
annotated Shiki fences unless a separate product decision changes the special-fence
contract.

## 18. Line Numbers

Line numbers are opt-in per code block and default OFF. Target forms:

````markdown
```ts:line-numbers
const a = 1
```

```ts:no-line-numbers
const b = 2
```

```ts:line-numbers=10
const c = 3
```
````

Requirements:

- custom starting value is positive and bounded;
- line numbers compose with highlight/focus/diff/warning/error state;
- wrapped visual lines do not receive extra logical numbers;
- line-number decoration is readable in all four reader theme states;
- PDF uses printable-light styling;
- copied code text does not unexpectedly include the gutter;
- line numbers do not use user-visible inline CSS variables or `style` attributes;
- preferred implementation is CSS counters or a sanitizer-safe, `aria-hidden` gutter;
- if new `aria-*`, tag, or class output is needed, add only the exact allowlist entries.

Line-number visuals must not be conveyed only by color, and they must not alter the
source bytes passed to Shiki.

## 19. Code Groups

### 19.1 Reader behavior

Target syntax:

````markdown
::: code-group

```js [JavaScript]
console.log('js')
```

```ts [TypeScript]
console.log('ts')
```

:::
````

The reader must show one panel at a time with:

- stable first-tab default;
- accessible tablist/tab controls or an equivalent keyboard-operable control model;
- visible label text;
- independent state for multiple code groups on one rendered surface;
- no Vue template compilation of `@click`, `v-if`, `v-for`, or any user-generated
  directive inside `v-html`;
- no inline event handlers;
- cleanup on rerender/unmount and no duplicate listeners.

The recommended architecture is a Nuvyn-owned post-render enhancement, analogous in
principle to Mermaid/MarkMap mounting, with a safe static HTML contract before mounting.

### 19.2 Sanitization and PDF

If accessible tabs require `button`, `role="tab"`, `role="tablist"`,
`aria-selected`, or `aria-controls`, a later implementation may add those exact
feature-specific tags/attributes. It must not enable arbitrary events, styles, or
unrestricted `data-*`.

PDF is non-interactive and deterministic. It must render every code-group member
sequentially with its label visible, regardless of which reader tab was active. It must
not export only the active panel.

## 20. Code Snippet Imports

### 20.1 Syntax and Nuvyn adaptation

Target VitePress-like syntax:

```markdown
<<< @/examples/demo.ts
<<< @/examples/demo.ts{2,4-6 ts:line-numbers} [demo]
<<< @/examples/demo.ts#region
```

The Nuvyn meaning of `@/` is proposed as the configured vault/resource root, not the
browser, Vite project root, or arbitrary host filesystem. `./foo` and `../foo` are
relative to the current Markdown document's vault path.

The current `/api/posts/*` endpoint only reads `.md` notes. Snippets therefore remain
P2/ADAPT until a safe resource resolver is designed and implemented. The browser must
send a logical vault-relative request; it must never read a path itself.

### 20.2 Required semantics

If snippets ship, they must support a controlled subset of:

- file path;
- inferred or explicit language;
- line ranges;
- named regions;
- optional display label;
- the shared fence metadata grammar.

The source is literal code content, escaped, and sent through the existing Shiki
runtime. It is never parsed as HTML, executed, or allowed to modify generated CSS.

The initial resource-content recommendation is text-only and UTF-8:

- snippets read text source files only; binary resources are rejected;
- Markdown includes read `.md` / Markdown text only;
- invalid UTF-8, unsupported resource types, and binary content produce a safe generic
  resource error rather than lossy decoding, a process failure, or host-path details;
- the exact source-extension allowlist, treatment of extensionless text files, and
  decoded-byte versus character-size limits remain explicit MD-EXT-6 open decisions.

### 20.3 Region contract

The recommended region grammar permits letters, digits, `_`, `-`, and `.`. Region
markers are common VS Code-style comment markers. The product must decide and document:

- whether all matching regions concatenate in source order;
- whether delimiter markers are stripped;
- nested-region behavior;
- missing/duplicate region behavior;
- maximum extracted bytes.

The safe default is: concatenate matching regions in source order, strip only the
matching delimiters, reject malformed nesting deterministically, and return a safe
visible error placeholder for missing regions without exposing server paths.

## 21. Markdown Includes

### 21.1 Syntax

Target syntax:

```markdown
<!--@include: ./parts/details.md-->
<!--@include: ./parts/basics.md{3,}-->
<!--@include: ./parts/basics.md#basic-usage-->
```

Nested includes may be supported only with depth and cycle limits. Include syntax is
resource expansion, not raw HTML and not a sanitizer escape hatch.

### 21.2 Required expansion order

The architectural order is frozen:

```text
raw source Markdown
    ↓
resolve Markdown includes / snippet directives
    ↓
expanded Markdown/resource representation
    ↓
discover final fenced-code languages
    ↓
prepare missing Shiki grammars
    ↓
MarkdownIt render
    ↓
Shiki / custom Markdown plugins
    ↓
DOMPurify
```

Included code can introduce a language not present in the parent source, so discovery
must happen after expansion. Included Markdown headings, custom anchors, duplicate
IDs, and TOC entries participate as one final document.

### 21.3 Include forms and errors

The initial MD-EXT-6 core supports line ranges and basic named-region selection only
after the resolver is proven. Heading/section selection is a deferred candidate, not a
release blocker for the core. Missing files, forbidden paths, cycles, depth/size
violations, and missing selections must render a safe visible placeholder such as:

```html
<div class="markdown-include-error">Unable to include resource.</div>
```

The placeholder must be sanitized, contain no raw OS error, host path, stack trace,
script, or style, and leave the rest of the document usable where practical.

### 21.4 Deferred code-file inclusion inside fences

Code-file inclusion inside a fence is a VitePress-referenced but Nuvyn-deferred
extension candidate. It is not required by the initial MD-EXT-6 core. If a later
product review approves it, the directive is literal code content, not nested Markdown.
For example:

````markdown
```js
<!--@include: ./examples/foo.js{2,10}-->
```
````

The implementation must:

- resolve the file through the same safe resource boundary;
- preserve selected bytes and indentation;
- escape them as code rather than parsing them as Markdown or HTML;
- pass the resulting source through Shiki using the surrounding language;
- prevent included bytes or a delimiter-like sequence from terminating the outer fence
  unexpectedly;
- apply snippet file/range/size/path limits;
- return a safe visible error if the resource or range is invalid.

## 22. Resource Resolution Model

### 22.1 Current limitation

Nuvyn currently has a secure server path helper, but its public post API is note-specific
and `.md`-specific. The implementation plan must not pretend that `<<< @/file.js` can
reuse `/api/posts/file.js`.

`resolveSafeRelativePathDetailed()` and `readSafeRelativeFile()` are physical,
root-relative safety helpers. Their intentional rejection of raw `.` and `..` segments
is part of the existing security boundary. This PRD does not require weakening or
changing those helpers to accept author-relative syntax; future implementation should
normalize author references logically first and then pass only the canonical result to
the existing or stronger physical resolver.

### 22.2 Two-stage resource-path model

Relative author syntax and physical filesystem safety are separate layers. The frozen
architecture is:

```text
author reference
    ↓
logical source-relative resolution
    ↓
vault-root-relative canonical logical path
    ↓
physical safe-path resolver
```

The conceptual logical helper may be named
`resolveLogicalResourceReference(sourcePath, resourceReference)`; the exact function
name is not frozen. It resolves the author reference against the current source file,
normalizes it to `/` logical separators, and returns a canonical vault-relative path.

For example:

```text
source document:  guides/java/index.md
reference:        ../examples/Demo.java
logical result:   guides/examples/Demo.java
canonical path:   guides/examples/Demo.java
physical input:   guides/examples/Demo.java
```

Authors may use `./foo` and `../foo` while this logical source-relative resolution is
running. A syntactic `..` is not inherently forbidden. It is valid only if normalization
produces a path that remains strictly inside the configured vault/resource root:

```text
source:           guides/java/index.md
reference:        ../shared/demo.ts
canonical path:   guides/shared/demo.ts
result:           ALLOWED
```

If normalization escapes the root, the reference is rejected before any read:

```text
source:           guides/index.md
reference:        ../../../etc/passwd
result:           REJECT — canonical path escapes the configured root
```

The canonical logical path must contain no `.` or `..` segments, must use `/` logical
separators, and must remain root-confined. The physical resolver receives only that
canonical path; it must never receive raw author syntax, dot segments, backslashes,
absolute paths, drive letters, UNC paths, or URI schemes.

The logical layer must reject, before or after normalization as appropriate:

- absolute Unix paths, absolute Windows paths, UNC paths, and drive-letter paths;
- backslashes, NUL bytes, and control characters;
- `file://`, `http://`, `https://`, and all other URI/protocol schemes;
- empty references and root-escape results;
- any normalized result containing `.` or `..` segments.

### 22.3 Future boundary requirements

A future authenticated resource resolver must:

- accept only a logical vault-relative path and source-document context;
- map `@/` to the configured Nuvyn resource root;
- map relative paths against the including/snippet source file's directory;
- validate lexical path syntax before filesystem resolution;
- reuse `resolveSafeRelativePathDetailed()` / `readSafeRelativeFile()` or a stronger
  equivalent;
- receive only the canonical root-relative path produced by the logical layer; raw
  `.`/`..` segments are never passed through;
- preserve the existing physical helper's rejection of absolute paths, backslashes,
  dot segments, `file://`, URLs, and protocol schemes;
- reject symlink/junction escapes and revalidate path identity during read;
- impose per-file, per-request, and final-expanded-document limits;
- avoid exposing host absolute paths in errors;
- use authenticated, authorized access consistent with vault reads;
- carry source path context for relative links, images, and WikiLinks;
- deduplicate repeated reads within one render when safe and deterministic;
- isolate request state between concurrent documents.

### 22.4 Included relative links and WikiLinks

Relative links and images inside an included file resolve relative to the included
file's own directory, not the parent document's directory. Nested includes update this
source context at every level.

WikiLinks inside included Markdown remain Nuvyn vault-aware. If the resolver needs a
source path, that included file path is provided rather than pretending all content
came from the parent. Resolver calls must not be duplicated by discovery/preflight.

## 23. Include/Snippet Security

Threats such as the following must be rejected before any read:

```text
../../../etc/passwd
/Users/name/.ssh/id_rsa
C:\Users\name\secret.txt
file:///etc/passwd
https://example.com/a.js
[https://example.com/a.js](https://example.com/a.js)
```

The contract is:

- a syntactic `../` is allowed only during logical source-relative resolution;
- the forbidden condition is a normalized canonical path that escapes the configured
  root, not the mere presence of `..` in author syntax;
- no absolute host paths;
- no canonical path escape outside the configured root;
- no symlink escape;
- no `file://` or network protocols;
- no browser-side filesystem access;
- no SSRF through include/snippet syntax;
- no arbitrary extension or resource type without an allowlisted policy;
- no lossy decoding of binary or invalid-UTF-8 resources; unsupported resources return
  a safe generic error without a host path;
- finite per-file and final output sizes;
- finite include depth and cycle detection by canonical logical path;
- errors are safe and do not reveal host paths;
- source is code/text content, never executable content;
- included HTML remains untrusted Markdown and goes through DOMPurify;
- included source cannot create generated CSS or modify the Shiki transformer;
- PDF uses already resolved/rendered content and does not independently reread paths.

## 24. Sanitizer Contract

The security boundary remains deny-by-default:

```ts
FORBID_ATTR: ['style']
```

The following are always forbidden:

- inline `style` attributes;
- event attributes such as `onclick`, `onerror`, or arbitrary `on*`;
- `<script>`, `<style>`, and other forbidden active/embedding tags;
- dangerous URI schemes and protocol escapes;
- arbitrary CSS or generated CSS derived from Markdown source;
- arbitrary Vue directives or component execution;
- unrestricted `data-*` attributes.

The required security treatment by surface is:

| Surface | Required boundary |
| --- | --- |
| Raw Markdown HTML | Remains untrusted and is sanitized after MarkdownIt rendering. |
| Custom anchors | Only the narrow generated `id` grammar; no generic attribute parsing. |
| Container titles | Escaped/rendered content; never raw attribute or HTML injection. |
| Additional attributes | Broad attrs rejected; only individually approved feature tokens. |
| Code annotations | Known structural classes only; no source-derived class/attribute names. |
| Code groups | Narrow semantic/ARIA markup only; no Vue directives or inline handlers. |
| Snippet paths | Vault-relative, authenticated, root-confined resource resolution. |
| Include paths | Same root/path policy, with source context and no network protocols. |
| Include recursion | Canonical-path cycle detection, depth limit, and size limits. |
| Included HTML | Still untrusted Markdown; it passes through the same DOMPurify boundary. |
| Generated CSS | Trusted Nuvyn/Shiki output only; never derived from Markdown source. |
| External links | Generated Markdown/linkify HTTP(S) links receive policy-owned `target`/`rel`; raw semantic HTML anchors keep the existing sanitizer contract and are not globally rewritten. |
| PDF export | Uses sanitized/resolved content and trusted export CSS; no trust bypass. |

Feature impact must be reviewed individually:

| Feature | Expected sanitizer impact |
| --- | --- |
| Custom anchors | Existing `id`/`href` allowlist should suffice; only safe generated IDs. |
| `[[toc]]` | Existing anchors/lists/nav-compatible tags, with exact new tags if needed. |
| Lazy images | `loading` is already allowed; no URL-policy change. |
| Containers/details | `div`, `details`, `summary`, `class` already fit the current contract. |
| Code annotations | Known `class` values only; no new user attributes. |
| Line numbers | Prefer CSS counters; otherwise exact `aria-hidden`/structural additions only. |
| Code groups | May need narrow `button`/ARIA attributes; no events/styles/arbitrary data. |
| Snippets/includes | No allowlist relaxation; expanded content is still untrusted Markdown/code. |
| External links | Generated Markdown/linkify `target`/`rel` are policy-controlled, not user-controlled; raw semantic HTML anchors are not implicitly rewritten by MD-EXT. |
| PDF | Sanitized/rendered content only; no PDF-only trust bypass. |

No feature may remove `FORBID_ATTR: ['style']` merely to make a renderer or transformer
work.

## 25. Theme Contract

The existing Shiki theme architecture remains unchanged:

- one Shiki runtime with `github-light` and `github-dark` token data;
- generated trusted class CSS outside sanitized article HTML;
- `src/shiki.css` and Nuvyn theme selectors own reader visuals;
- `data-theme="light"` beats OS dark;
- `data-theme="dark"` forces dark;
- no `data-theme` follows the OS fallback;
- switching theme changes CSS only and does not rerender Markdown or retokenize code.

New annotation, line-number, container, and code-group classes must be styled in a
Nuvyn-owned stylesheet path. They must not create per-document style tags or use
user-supplied class names as selectors.

The future implementation must keep token colors and structural decoration readable
under:

```text
system light
system dark
forced light
forced dark
```

## 26. PDF Contract

PDF uses the printable-light surface and must not depend on the reader's active theme or
active code-group tab. `PdfExportSurface.vue`, `pdfExport.ts`, `pdf-readiness.ts`, and
the existing clone/staticization lifecycle remain authoritative.

| Feature | Reader behavior | PDF behavior |
| --- | --- | --- |
| Custom anchors | Final safe IDs and working links | Preserve final IDs and internal links where supported |
| `[[toc]]` | Interactive internal navigation | Static TOC using final IDs |
| Info/tip/warning/danger containers | Nuvyn styled structural blocks | Printable structural blocks with readable labels |
| `details` | Native open/close behavior | Expanded content with visible summary/title |
| Code line highlight | Highlighted logical lines | Highlight remains distinguishable in light palette |
| Focus | Focused lines readable, others de-emphasized | Focus semantics preserved without dark-reader leakage |
| Diff | Add/remove lines distinct | Printable add/remove cues, not color-only where practical |
| Warning/error/info | Semantic line state | Printable severity cues and readable labels/contrast |
| Line numbers | Optional, logical, non-copying gutter | Optional gutter with correct start and wrapping |
| Code groups | One accessible panel visible at a time | Every panel sequentially with labels |
| Snippet content | Resolved once in reader pipeline | Use resolved content; no independent filesystem read |
| Included Markdown | Expanded final document | Expanded content with final IDs/links |
| Lazy images | Reader may defer load | Readiness waits for required images and embeds them |
| Mermaid/MarkMap | Existing mount lifecycle | Existing staticization behavior unchanged |

The completed H6 evidence already proves actual nested Shiki token colors in PDF. New
annotation and line-number work must extend that style of evidence rather than asserting
only that a `<pre>` or background exists. Long lines must wrap, pages must paginate,
and code-heavy exports must remain usable.

## 27. Mermaid / MarkMap Compatibility

The exact existing special fences remain outside normal Shiki code processing:

````markdown
```mermaid
graph TD
A --> B
```

```markmap
# Root
## Child
```
````

They continue to emit encoded `data-content` placeholders with `.mermaid-mount` and
`.markmap-mount`, then use their existing mount/staticization lifecycle. New metadata
parsing must not reinterpret them accidentally. In particular, `mermaid{1}` and
`markmap{1}` are not automatically normal annotated fences; exact special-fence
behavior must be reviewed separately if changed.

Any `features.hljs` or highlight.js reference owned by MarkMap's transitive package is
not a Nuvyn normal Markdown renderer contract and must not be removed as part of this
program. The H8 release gate already classified this ownership distinction.

## 28. Accessibility

New features must meet these minimum expectations:

- heading anchors are keyboard/link targets without hiding heading text;
- TOC has a semantic navigation/list structure and visible focus states;
- external links communicate new-window behavior through the accepted policy;
- `details` uses native `summary` semantics;
- code groups use tab semantics or an equivalently understandable, keyboard-operable
  control model;
- focus-visible styles remain visible in reader themes;
- line-number gutters are `aria-hidden` or otherwise excluded from copied/accessibility
  code text;
- diff and severity states are not conveyed by color alone where practical;
- container titles remain readable and are not icon-only;
- PDF labels and all code-group members remain understandable without interaction.

This is not a full WCAG redesign of Nuvyn. It is a release gate against obvious new
keyboard, focus, semantic, and content-copy regressions.

## 29. Performance

The implementation must preserve these budgets/invariants:

- one MarkdownIt singleton, not one instance per render;
- one Shiki highlighter and one `transformerStyleToClass` instance;
- no theme-triggered Markdown rerender or syntax retokenization;
- TOC uses the same final heading/token model, not an unrelated full parser;
- resource resolution deduplicates repeated reads within one render where safe;
- include recursion, per-file size, and final expanded size are bounded;
- no eager execution of the entire Shiki grammar catalog;
- annotations do not create another highlighter or an extra full render pass;
- code-group tab switches do not tokenize the same source repeatedly;
- generated CSS remains one trusted owner and is not emitted per code block/render;
- concurrent documents cannot share mutable resolver/resource state accidentally.

The later release gate must compare initial JS and lazy Shiki/grammar chunks. The goal is
not zero byte growth; it is no accidental eager all-language bundle, duplicate runtime,
duplicate grammar loading, or repeated tokenization.

## 30. Async / Resolver Architecture Constraints

### 30.1 Async rendering

Nuvyn `render()` is already async because languages are prepared before synchronous
MarkdownIt rendering. A future resource phase may add:

```ts
await resolveResources(...)
await prepareShikiLanguages(...)
const html = md.render(...)
const safe = sanitizeMarkdownHtml(html)
```

The program must not require an async MarkdownIt renderer unless implementation evidence
proves it unavoidable. MarkdownIt remains the parser.

### 30.2 Resolver isolation

The H2 resolver blocker is closed and must remain closed. Discovery/preflight and final
render use separate env objects:

```text
preflight parse → isolated discovery env, no caller wikiResolver
resource/fence preparation
final render → fresh real env with the caller resolver
```

Future include expansion must carry source path separately from the final render env.
It must not invoke the caller's WikiLink resolver during fence discovery, invoke it a
second time for TOC collection, or leak one concurrent render's env into another.

### 30.3 Reader lifecycle

Interactive features must fit `RenderedMarkdown.vue` and existing post-render mounting:

- mount after sanitized `v-html` insertion;
- clean up when content is replaced or component unmounts;
- avoid duplicate handlers on rerender;
- keep multiple documents and multiple code groups independent;
- make PDF representation deterministic and non-interactive.

## 31. Malformed Input Behavior

Malformed syntax must fail safely, deterministically, and locally where practical:

| Input | Required behavior |
| --- | --- |
| `# Heading {#}` | No unsafe ID; preserve visible text or fall back to automatic heading slug. |
| `# Heading {#bad anchor}` | Reject custom metadata; never emit an attribute containing spaces. |
| `[[TOC]]` | Not the initial directive; render according to ordinary Markdown/WikiLink behavior. |
| `::: unknown` | No arbitrary type/class/component; safe fallback or visible ordinary content. |
| Unclosed `:::` | Deterministic ordinary/fallback rendering; do not consume unrelated document tail. |
| ````ts:line-numbers=abc```` | Ignore invalid modifier and render safe ordinary code. |
| ````ts {10-3}```` | Ignore invalid range or safe fallback; never throw. |
| `[!code focus:0]`, `[!code focus:-1]`, or `[!code focus:x]` | Ignore/reject the malformed span safely; never throw or emit source-derived classes. |
| `[!code focus:999999999]` | Apply only bounded official semantics or safely ignore/clamp; never allocate unbounded state. |
| `./foo.ts` from a source file | Resolve logically against the source file, then pass only the canonical root-relative path to the physical resolver. |
| `../foo.ts` that remains inside the root | Allow after logical normalization; the physical resolver receives no `..`. |
| `<<< ../../../secret` | Visible safe snippet error; no file read. |
| `<!--@include: ../../../secret-->` | Visible safe include error; no file read. |
| `C:\\Users\\name\\secret.txt`, `/Users/name/.ssh/id_rsa`, or `file:///etc/passwd` | Reject before read; no Windows/absolute/protocol path reaches the physical resolver. |
| Binary or invalid-UTF-8 resource | Safe generic resource error; no lossy decode, crash, or host-path disclosure. |
| Recursive include A → B → A | Stop at cycle boundary; render safe error placeholder. |
| Missing region | Safe visible placeholder/error; no stack or host path. |
| Missing included file | Rest of document remains usable where practical. |
| Raw HTML/script/style/event input | Existing DOMPurify policy remains authoritative. |
| `mermaid{1}` / `markmap{1}` | Do not change exact special-fence behavior implicitly. |

No malformed input may enable arbitrary filesystem access, network fetch, CSS, scripts,
Vue execution, or sanitizer bypass.

## 32. Testing Strategy

### 32.1 Unit tests

The later implementation program must add or extend tests for:

- custom anchors, safe grammar, duplicates, invalid values, and permalink output;
- TOC, default h2-h4 range, custom-anchor IDs, duplicates, HTML text, and no-resolver
  behavior;
- external-link classification and `target`/`rel` policy;
- lazy image attributes and URI/sanitizer regression;
- containers, titles, details, nesting, unknown types, and callout coexistence;
- fence metadata grammar, ranges, labels, line-number modifiers, and malformed input;
- Shiki highlight/focus/diff/warning/error/info notation, `focus:N`, approved
  `highlight:N` scope, and class-only output;
- annotation marker visibility and generated CSS ownership;
- line numbers, starting values, wrapping/copy/accessibility structure;
- code-group parsing, labels, isolation, malformed groups, and lifecycle seam;
- snippet logical-path normalization (`./`, `../` within root, root escape, source-at-root,
  nested source context), absolute/Windows/protocol rejection, regions, ranges, language
  inference, text/UTF-8 policy, limits, and safe errors;
- include path validation, relative context, nested expansion, cycles, depth, size, and
  heading/TOC participation for the approved core; deferred heading-section and
  code-file-in-fence candidates must have separate tests only if approved;
- included resource URL rebasing and WikiLink resolver source context;
- external-link scope: generated Markdown links, linkify URLs, internal links, WikiLinks,
  `mailto`, `tel`, fragments, relative URLs, and raw HTML `<a>` behavior;
- resolver isolation and concurrent render independence;
- DOMPurify regression: style/event/script/URI/data-* policies remain strict;
- exact MarkMap/Mermaid bypass and existing math behavior.

### 32.2 Browser/E2E tests

At minimum:

- reader light, reader dark, forced light, forced dark, and OS fallback;
- CSS-only theme switching without Markdown rerender or DOM/token identity changes;
- TOC navigation and custom-anchor navigation;
- container rendering, details interaction, and nested content;
- multiple independent code groups and keyboard behavior;
- line annotations and line numbers with long wrapped code;
- external link behavior and focus visibility, including generated links versus raw HTML;
- lazy-image reader layout;
- safe include/snippet rendering and visible error states;
- MarkMap/Mermaid/math regressions;
- no user CSS/events/scripts survive in rendered Markdown.

### 32.3 PDF tests

At minimum:

- TOC and custom-anchor internal links;
- containers and expanded details;
- annotation highlight/focus/diff/warning/error/info semantics;
- line numbers and custom starts;
- all code-group panels with labels;
- included and snippet content;
- lazy-image readiness;
- printable-light computed token colors under every reader theme state;
- wrapping, pagination, code-heavy stress, Mermaid, MarkMap, and math.

## 33. Product Phase Recommendation

Use a new phase namespace. Do not use `H9`, `SHIKI-H9`, or any name that suggests the
completed Shiki migration is reopening.

Recommended sequence:

| Phase | Scope | Exit focus |
| --- | --- | --- |
| MD-EXT-0 | Baseline & compatibility contract | Current feature inventory, parser/security/PDF constraints, open decisions reviewed. |
| MD-EXT-1 | Anchors, TOC, links & lazy images | Final heading IDs, Nuvyn links, safe external links, image readiness. |
| MD-EXT-2 | Custom containers | Built-ins, titles, nesting, callout coexistence, details semantics. |
| MD-EXT-3 | Shiki code annotations | Unified metadata, official class transformers, theme/PDF/security proof. |
| MD-EXT-4 | Line numbers | Opt-in structural gutter, wrapping, accessibility, PDF. |
| MD-EXT-5 | Code groups | Accessible post-`v-html` enhancement, cleanup, complete static PDF output. |
| MD-EXT-6 | Safe snippets & Markdown includes | Initial core: authenticated resource boundary, logical-to-physical path resolution, text/UTF-8 policy, line ranges, basic named regions, nested includes, cycles/depth/size limits, source-path context, rebasing, and Shiki discovery after expansion. Heading/section selection and code-file inclusion inside fences are deferred candidates. |
| MD-EXT-7 | Full regression & release gate | DoD, bundle/performance audit, reader/PDF/browser regression, docs closure. |

This PRD is not an implementation plan. A later plan must decide exact files, tests,
rollback boundaries, and any dependency additions only after MD-EXT-0 review.

## 34. Open Decisions

The following decisions are intentionally surfaced for product review. The listed
recommendations are defaults for planning, not permission to silently implement them.

| Decision | Recommendation | Rationale | Security/compatibility implication |
| --- | --- | --- | --- |
| 1. TOC default levels | h2-h4 | Matches current page-nav and excludes the document title. | Must share final IDs and not call WikiLink resolver. |
| 2. Expose `[!code info]` | Yes, as a Nuvyn extension aligned with the installed transformer | Shiki officially supports info-level class output; it adds useful parity without new runtime. | Only known `info` class; no user class/style input. |
| 3. Support `details {open}` | Prefer yes, narrowly | Useful VitePress-compatible affordance with one boolean semantic attribute. | Recognize only `open`; reject all other attrs and preserve style ban. |
| 4. Arbitrary custom container registration | Defer | No current public safe plugin/configuration surface. | Avoid runtime code injection and unbounded CSS/type names. |
| 5. `mermaid{...}` / `markmap{...}` | Keep exact identifier bypass only | Prevent metadata parser from changing special mount behavior accidentally. | Preserves existing lifecycle and security tests. |
| 6. Non-Markdown snippet resources | Require a new safe resource endpoint | Current `/api/posts/*` is `.md`-specific; generic server helpers exist but are not a public API. | Root confinement, symlink checks, auth, limits, and no network are mandatory. |
| 7. Meaning of `@/` | Configured Nuvyn vault/resource root | Closest Nuvyn equivalent to VitePress source root. | Must never mean host root or browser filesystem. |
| 8. Maximum snippet size | Recommend 256 KiB per extracted snippet | Keeps a single code block bounded while allowing normal source files. | Enforce before Shiki; avoid memory/bundle/UI abuse. |
| 9. Maximum include file size | Recommend 512 KiB per included file | Includes can be Markdown and may be larger than a snippet but remain bounded. | Enforce before recursive expansion. |
| 10. Maximum final expanded size | Recommend 2 MiB per render | Limits recursive content amplification and DOM/PDF load. | Abort expansion with safe visible placeholder. |
| 11. Maximum include depth | Recommend 8 | Supports practical composition while bounding recursion. | Detect cycles by canonical logical path, not only depth. |
| 12. Include errors | Safe visible placeholder with generic text | Interactive reader should preserve the rest of the document. | Never expose OS paths, stack traces, or raw errors. |
| 13. Section/heading include | Defer from the MD-EXT-6 core; review separately | It depends on final heading IDs and source-context semantics. | Must not create a second slugger or include unsafe ranges. |
| 14. Code-group sanitizer markup | Use narrow buttons/ARIA if needed | Native accessible tabs are better than non-semantic clickable divs. | Add exact tag/ARIA allowlist only; no events/style/data wildcard. |
| 15. Global line-number default | OFF | Avoid changing existing code block layout for every note. | Per-fence metadata remains explicit and bounded. |
| 16. Include region marker policy | Concatenate matching regions, strip matching delimiters | Closest practical subset to VitePress/VS Code semantics. | Reject malformed nesting and bound output. |
| 17. Unknown container behavior | Safe ordinary/fallback rendering with no arbitrary class | Keeps malformed content usable without dynamic types. | Prevents CSS/class/component injection. |
| 18. Resource content model | Recommend text-only resources decoded as UTF-8; snippets are source text and includes are Markdown text | Prevents binary data from being lossy-decoded into code/Markdown. | Binary, invalid UTF-8, and unsupported types return safe generic errors; no path disclosure. |
| 19. Exact resource extension policy | Open; decide whether to use a source-extension allowlist or permit any validated UTF-8 text | The safe content model is clear, but extensionless/text-extension coverage is a product choice. | Must not broaden physical access; enforce type, byte, and decode limits before render. |
| 20. Code-file inclusion inside fences | Defer unless separately approved after MD-EXT-6 core | VitePress documents the syntax, but Nuvyn does not need it to ship the initial safe include core. | Keep literal-code escaping and the same resolver if later enabled. |

The implementation plan must record the approved answers and update this section only
through an explicit PRD review.

## 35. Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| Generic attrs creep | User Markdown can inject classes, styles, or behavior. | Reject broad attrs; add only feature-specific allowlist entries. |
| TOC/anchor drift | Links point to missing or duplicate IDs. | One final heading-ID source; test custom/duplicate/include headings. |
| Container parser ambiguity | Nested content or callouts are swallowed. | MarkdownIt fence-length semantics and malformed-input tests. |
| Shiki transformer mismatch | Annotations look correct in reader but fail security/PDF. | Official class transformers, one existing style transformer, computed-color PDF tests. |
| Line-number text pollution | Copy/paste or screen readers include gutter numbers. | CSS counters or `aria-hidden` structural gutter; browser accessibility tests. |
| `v-html` interaction assumption | Code groups become inert or unsafe. | Post-render Nuvyn enhancement, no Vue compilation, lifecycle cleanup tests. |
| Resource resolver bypass | Snippets/includes expose host files or SSRF. | Authenticated vault-root endpoint, lexical/physical confinement, no URLs, limits. |
| Include amplification | Large/cyclic content freezes reader or PDF. | Cycle detection, depth/file/final-size limits, deduped reads. |
| Resolver double calls | Expensive or stateful WikiLink resolution changes output. | Isolated discovery env, source-aware resource context, concurrency tests. |
| PDF state leakage | Dark reader or active tab changes exported content. | Static light clone, all-panel export, computed token/visual assertions. |
| Dependency overreach | VitePress or another parser changes architecture/bundle. | Keep MarkdownIt/Shiki baseline; review every dependency addition separately. |
| Overpromising parity | Authors rely on unsupported VitePress runtime features. | Publish compatibility matrix and explicit non-goals. |

## 36. Definition of Done

The complete MD-EXT program is releasable only when the approved release scope proves:

### Product behavior

- [ ] custom heading anchors work, remain safe, deduplicate deterministically, and do
  not display valid metadata;
- [ ] TOC is generated from final heading IDs, includes approved levels, handles custom
  anchors/duplicates/includes, and does not invoke WikiLink resolver unexpectedly;
- [ ] existing automatic anchors, page navigation, internal Nuvyn links, WikiLinks,
  `.md` links, frontmatter, tables, task lists, footnotes, definition lists, mark,
  emoji, math, callouts, Mermaid, and MarkMap do not regress;
- [ ] external links follow the approved Nuvyn target/rel contract;
- [ ] images can lazy-load without changing URL security, reader layout, readiness, or
  PDF inclusion;
- [ ] info/tip/warning/danger/details containers work with titles and deterministic
  nesting;
- [ ] existing blockquote callouts remain compatible and coexist with containers;
- [ ] arbitrary generic attributes are not enabled;
- [ ] `::: raw` does not bypass sanitization;
- [ ] normal Shiki highlighting remains on the H8 pipeline;
- [ ] line metadata, `[!code highlight]`, focus, diff, warning, error, and approved info
  annotations work;
- [ ] annotation output is class-based and has no Markdown-derived inline style;
- [ ] line numbers are opt-in, support custom starts, wrap correctly, and do not pollute
  code copying/accessibility;
- [ ] code groups have stable labels, independent state, keyboard-operable controls,
  rerender cleanup, and no Vue template execution;
- [ ] PDF exports every code-group panel, not only the active reader panel;
- [ ] safe snippets and includes, if included in the approved release, enforce root
  confinement after logical normalization, auth, symlink protection, no network access,
  text/UTF-8 policy, file/final-size limits, depth, cycles, and safe errors;
- [ ] include-relative links/images resolve against the included source path;
- [ ] included headings/custom anchors participate in final IDs and TOC;
- [ ] snippet/include languages are present before Shiki preparation;
- [ ] included code remains escaped literal source and cannot execute or alter generated
  CSS.
- [ ] deferred heading/section selection and code-file inclusion inside fences do not
  block the initial release unless separately approved and added to its scope.

### Architecture and security

- [ ] one MarkdownIt singleton remains;
- [ ] one Shiki runtime/highlighter remains;
- [ ] one `transformerStyleToClass` instance and one generated stylesheet owner remain;
- [ ] no theme-triggered Markdown rerender or syntax retokenization occurs;
- [ ] MarkMap remains outside normal Shiki and its transitive ownership references are
  not incorrectly deleted;
- [ ] Mermaid remains outside normal Shiki with its placeholder/mount lifecycle;
- [ ] `DOMPurify` remains strict;
- [ ] `FORBID_ATTR: ['style']` remains unchanged;
- [ ] events, scripts, style tags, dangerous URIs, arbitrary data attributes, and
  user-supplied CSS remain forbidden;
- [ ] no Vue component/directive execution is introduced in Markdown;
- [ ] no host filesystem escape, SSRF, `file://`, absolute path, backslash, or canonical
  root escape is possible; physical resolver input contains no dot segments.

### Reader, accessibility, and PDF

- [ ] reader light/dark, forced light/dark, and OS fallback pass;
- [ ] theme switching remains CSS-only;
- [ ] anchor, TOC, details, and code-group keyboard/focus semantics pass;
- [ ] annotations remain distinguishable without relying only on color where practical;
- [ ] PDF is printable light under every reader theme state;
- [ ] PDF proves actual nested token colors, not only backgrounds or element existence;
- [ ] PDF includes final TOC/anchors, expanded details, all code-group panels, annotations,
  line numbers, images, snippets/includes, Mermaid, MarkMap, math, wrapping, and pagination
  according to the approved scope.

### Verification and release hygiene

- [ ] Markdown compatibility unit tests pass;
- [ ] resource/security/resolver isolation tests pass;
- [ ] browser reader tests pass;
- [ ] PDF export/layout/pagination/stress tests pass;
- [ ] typecheck passes;
- [ ] unit suite passes;
- [ ] production build passes;
- [ ] bundle audit shows no accidental eager Shiki grammar catalog or duplicate runtime;
- [ ] deferred/rejected features are not accidentally present;
- [ ] documentation and compatibility matrix reflect the shipped scope;
- [ ] a separate implementation plan and release-gate evidence document are updated;
- [ ] the completed Shiki H0-H8 migration remains closed; no H9 is created.

## 37. Required Compatibility Examples

The following examples are normative acceptance inputs for the future implementation
plan. The exact generated HTML may differ from VitePress, but the product behavior
described beside each example is required.

### 37.1 Anchors, TOC, and containers

```markdown
# Java Guide {#java-guide}

[[toc]]

::: tip
Important note
:::

::: danger STOP
Do not continue
:::

::: details Example {open}
Hidden content
:::
```

Expected behavior:

- the H1 has final ID `java-guide` and does not show `{#java-guide}`;
- TOC entries use final IDs and the approved h2-h4 range;
- tip/danger render as Nuvyn-owned structural containers with safe titles;
- details renders native semantic details and is open only if the narrow `{open}`
  decision is approved;
- no inline style or arbitrary attribute is emitted.

### 37.2 Code annotations

````markdown
```ts {1,3-5}
const a = 1
const b = 2
const c = 3
const d = 4
const e = 5
```

```ts
const before = 1 // [!code --]
const after = 2  // [!code ++]
```

```ts
danger() // [!code error]
warn()   // [!code warning]
info()   // [!code info]
```

```ts
const first = 1 // [!code focus:3]
const second = 2
const third = 3
```

```ts:line-numbers=10
const a = 1
const b = 2
```
````

Expected behavior:

- final HTML uses official-compatible line/outer classes and Nuvyn CSS;
- token colors remain class-based and theme-switchable without rerender;
- diff/severity/line-number state survives PDF in printable light;
- `[!code focus:3]` applies the official multi-line focus semantics;
- malformed metadata falls back safely;
- code text does not contain visible gutter numbers when copied where practical.

`[!code highlight:3]` is intentionally not a normative initial example because that
extension remains deferred until official transformer range semantics are confirmed.

### 37.3 Code groups

````markdown
::: code-group

```js [JavaScript]
console.log('js')
```

```ts [TypeScript]
console.log('ts')
```

:::
````

Expected behavior:

- one accessible reader panel is visible initially;
- each tab changes only the group-local panel;
- no Vue directive is compiled from the Markdown HTML;
- PDF exports both labeled panels sequentially.

### 37.4 Resources

```markdown
<<< @/examples/demo.ts

<!--@include: ./parts/details.md-->
```

Logical source-relative normalization:

```text
source document:  guides/java/index.md
reference:        ../shared/example.ts
canonical path:   guides/shared/example.ts
result:           ALLOWED
```

Root escape rejection:

```text
source document:  guides/java/index.md
reference:        ../../../../etc/passwd
result:           SAFE ERROR — no resource read
```

Expected behavior if MD-EXT-6 is in the approved release:

- `@/` is resolved only through the authenticated Nuvyn resource root;
- `./` and `../` are resolved relative to the current Markdown file only in the logical
  layer; the physical resolver receives the canonical root-relative path with no dot
  segments;
- resource expansion completes before final fence discovery and Shiki preparation;
- included headings/links/URLs use source-file context;
- missing/forbidden resources produce safe visible errors, not process failures.

## 38. Research References and Traceability

The syntax inventory and examples were checked against the official VitePress page as
observed in VitePress `2.0.0-alpha.19` on `2026-08-21`, and against:

- [VitePress — Markdown Extensions](https://vitepress.dev/guide/markdown.html): official
  author-facing syntax for anchors, links, tables, tasks, footnotes, emoji, TOC,
  containers, alerts, Shiki annotations, line numbers, snippets, code groups, includes,
  math, lazy images, and configuration.
- [Shiki — `@shikijs/transformers`](https://shiki.style/packages/transformers): official
  transformer capabilities and class contracts for metadata highlights, notation
  highlight/focus/diff/error levels, and `transformerStyleToClass`.
- Nuvyn `src/lib/markdown.ts`, `src/lib/shiki.ts`, `src/shiki.css`,
  `src/composables/vault/useMarkdownRender.ts`, `src/lib/callouts.ts`, `src/lib/math.ts`,
  `src/lib/frontmatter.ts`, `src/lib/pdfExport.ts`, `src/lib/pdf-readiness.ts`,
  `src/components/vault/RenderedMarkdown.vue`, `src/components/vault/PdfExportSurface.vue`,
  `server/paths.ts`, `server/routes/posts.ts`, and the H8 release-gate evidence.

This is a Nuvyn product contract. VitePress documentation establishes syntax reference;
Nuvyn source and H8 evidence establish security, routing, lifecycle, and PDF behavior.
