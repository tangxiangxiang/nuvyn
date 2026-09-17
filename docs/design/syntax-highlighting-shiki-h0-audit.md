# Nuvyn Shiki H0 — Baseline & Contract Audit

> H0 is an audit/evidence phase only. This document records the repository as it existed before Shiki implementation. It does not install Shiki, change the renderer, or change application behavior.

## 1. Audit metadata

| 项目 | 内容 |
| --- | --- |
| Audit status | `SHIKI-H0 — COMPLETE`；仅完成审计、证据和文档落盘 |
| Product constraint | [Shiki Syntax Highlighting Migration PRD](syntax-highlighting-shiki-migration-prd.md) |
| Execution map | [Shiki Syntax Highlighting Migration Implementation Plan](syntax-highlighting-shiki-migration-implementation-plan.md) |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| Audit HEAD | `dd6281a085341e09d599f4ddae45cf0661206e81` |
| H0 completion commit | `f9e02270d235fb1eb01ab5ee796322249a1506fe` |
| Audit date | 2026-08-21 |
| Local evidence runtime | Node `v24.15.0`、npm `11.12.1` |
| Repository runtime baseline | `Dockerfile` uses `node:22-bookworm-slim` for dependency, build and runtime stages |
| Current renderer | Nuvyn normal Markdown fences still use highlight.js |
| Shiki status | Not installed; `@shikijs/transformers` not installed |
| H0 scope | Baseline/contract audit only；不修改 production source、dependencies、tests、CSS、lockfile 或 PDF implementation |

Implementation baseline and audit HEAD are intentionally different. The implementation baseline is the documented starting point for the migration; the later HEAD contains documentation-only corrections and does not mean that Shiki work has started.

## 2. Repository/environment baseline

The repository was clean at the beginning of H0. The recorded commands and results were:

```text
git status --short
<no output; clean>

git rev-parse HEAD
dd6281a085341e09d599f4ddae45cf0661206e81

git log -5 --oneline
dd6281a docs(shiki): fix migration implementation baseline
2be6b2c docs(shiki): add migration implementation plan
d342147 test(pdf-export): stabilize pagination boundary evidence
7f79d00 docs: add Shiki migration PRD
e745298 docs(pdf-export): align final acceptance evidence

node --version
v24.15.0

npm --version
11.12.1
```

The migration baseline remains `2be6b2c...`; it was not rewritten to the current HEAD. Local evidence was collected with Node 24, while the Dockerfile baseline is Node 22, so a future CI/container comparison must account for that runtime difference.

## 3. Dependency baseline

`package.json` and the npm lockfile were inspected without changing them.

| Dependency | `package.json` declared | `package-lock.json` resolved |
| --- | --- | --- |
| highlight.js | `^11.10.0` | `11.11.1` |
| markdown-it | `^14.1.0` | `14.2.0` |
| vue | `^3.5.34` | `3.5.35` |
| vite | `^8.0.12` | `8.0.16` |
| typescript | `~6.0.2` | `6.0.3` |
| dompurify | `^3.4.10` | `3.4.10` |
| html2pdf.js | `^0.14.0` | `0.14.0` |
| markmap-lib | `^0.18.12` | `0.18.12` |
| markmap-view | `^0.18.12` | `0.18.12` |
| mermaid | `^11.15.0` | `11.15.0` |
| markdown-it-anchor | `^9.2.0` | `9.2.0` |
| markdown-it-deflist | `^3.0.1` | `3.0.1` |
| markdown-it-footnote | `^4.0.0` | `4.0.0` |
| markdown-it-mark | `^4.0.0` | `4.0.0` |
| markdown-it-task-lists | `^2.1.1` | `2.1.1` |

The H0 dependency facts are:

- Shiki: **NO**; it is not declared or resolved.
- `@shikijs/transformers`: **NO**; it is not declared or resolved.
- highlight.js: **YES**; it is directly declared and remains the active normal-fence renderer.
- `markmap-lib` also declares highlight.js transitively (`^11.8.0` in `package-lock.json`, resolved to `11.11.1`). This is MarkMap-owned dependency state and must not be confused with the Nuvyn renderer dependency during H7 cleanup.
- The tracked `pnpm-lock.yaml` also records highlight.js `11.11.1`. Its importer has a separate existing hygiene discrepancy for `better-sqlite3` (the package manifest/ npm lock use `12.11.1`, while the pnpm importer still shows the older `^11.7.0`/`11.10.0` pair). H0 did not repair this unrelated lockfile discrepancy.

## 4. highlight.js reference inventory

The inventory command was:

```bash
rg -n -i \
  'highlight\.js|hljs|\.hljs|hljs-|github\.css|hljs-dark' . \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!.git/**'
```

The relevant results are classified below. This classification is the handoff for H7; a mechanical repository-wide deletion is unsafe.

### A. Nuvyn normal Markdown renderer

| Location | Evidence | Future disposition |
| --- | --- | --- |
| `src/lib/markdown.ts:159-203` | Dynamic import of `highlight.js`, `highlight.js/styles/github.css`, and `../hljs-dark.css`; `getLanguage()`/`highlight()`; normal output `<pre class="hljs"><code>…` | H3 cutover, H4/H5 parity, H7 removal |
| `package.json:39` | Direct `highlight.js` dependency | Keep through rollback/parity; H7 removal |
| `package-lock.json:21,3459-3465` | Direct lock entry for highlight.js `11.11.1` | Remove only after Nuvyn runtime no longer consumes it |
| `pnpm-lock.yaml:35-37,1251,3106` | Direct importer/package entries | Review with the repository’s chosen package-manager policy during H7 |

### B. Nuvyn CSS/theme integration

| Location | Evidence | Future disposition |
| --- | --- | --- |
| `src/lib/markdown.ts:168-169` | Loads GitHub light CSS and `src/hljs-dark.css` during highlighter initialization | Replace only after Shiki theme CSS is wired |
| `src/hljs-dark.css:1-98` | GitHub-dark token/background selectors, OS-dark and forced-dark scopes | Preserve through H5; remove only in H7 |

### C. Nuvyn tests and pipeline comments

| Location | Evidence | Future disposition |
| --- | --- | --- |
| `src/lib/__tests__/markdown.test.ts:8,47-53` | Async hljs-init comment and explicit normal-fence `class="hljs"` assertion | Migrate assertion at H3; retain special-fence/security coverage |
| `src/composables/vault/__tests__/useMarkdownRender.test.ts:16,87-90` | Comments describe the current highlight.js async import | Update only with the renderer migration |

### D. Documentation/history or product-adjacent text

| Location | Evidence | Future disposition |
| --- | --- | --- |
| `server/ai/prompt.md:64` | Says non-special language identifiers render through highlight.js | Review as part of H7 documentation/prompt cleanup; it is not the Nuvyn Markdown renderer implementation |
| `docs/archive/plans/2026-06-07-sqlite-ai-history.md:64` | Historical dependency snippet | Preserve as history unless a separate documentation policy says otherwise |
| PRD/implementation plan | Deliberate migration requirements and historical references | Preserve as design evidence; do not treat as runtime references |

### E. MarkMap-owned/internal contract

| Location | Evidence | Future disposition |
| --- | --- | --- |
| `src/lib/__tests__/markmapSecurity.test.ts:86-88` | MarkMap’s own `Transformer` is configured with `features.hljs`; rendered MarkMap HTML is expected to contain an `hljs` class | Do not delete automatically; classify as external MarkMap contract |
| `package-lock.json:4260+` | `markmap-lib` transitively depends on highlight.js | May remain after Nuvyn direct runtime removal if MarkMap still requires it |

### F. Generated/third-party artifacts

The production build emitted ignored assets such as `dist/assets/github-DdKuH37F.css` and `dist/assets/hljs-dark-Gf5kSmHw.css`. These are generated evidence, not tracked source changes. `aiMarkdown` has a separate MarkdownIt renderer and a `language-ts` code contract; it is not the vault renderer in this migration surface.

There were no additional relevant Nuvyn-owned runtime references outside this classification. H7 must prove that Nuvyn-owned runtime/CSS references are gone while separately explaining MarkMap/transitive and historical hits.

## 5. Markdown rendering pipeline

The actual current path is:

```text
raw Markdown
    ↓
useMarkdownRender.watchEffect()
    ↓
render(body, { resolver })
    ↓
getMd()
    ↓
buildHighlight()
    ├─ dynamic import highlight.js
    ├─ dynamic import github.css
    └─ dynamic import src/hljs-dark.css
    ↓
one MarkdownIt singleton with synchronous highlight callback
    ↓
md.render(markdown, per-render env)
    ↓
DOMPurify.sanitize(final HTML)
    ↓
RenderedMarkdown
    ↓
v-html into the article element
```

| Stage | File | Function/API | Async? | User-controlled input? |
| --- | --- | --- | --- | --- |
| Source/watch | `src/composables/vault/useMarkdownRender.ts:95-133` | `watchEffect`, `parseDoc`, `render` | Yes; cancellation-aware | Raw document content and resolver |
| Runtime init | `src/lib/markdown.ts:159-203` | `buildHighlight` | Yes; dynamic imports | Fence source reaches callback later |
| MarkdownIt creation | `src/lib/markdown.ts:205-264` | `getMd` / `new MarkdownIt` | Lazy async once, then singleton | Plugin input is document content |
| Render | `src/lib/markdown.ts:270-274` | `md.render(markdown, env)` | The call is synchronous inside async `render()` | Yes; per-render wiki resolver in `env` |
| Highlight callback | `src/lib/markdown.ts:177-201` | MarkMap/Mermaid branches, `hljs.highlight`, escaped fallback | Synchronous callback | Fence info string and source |
| Sanitization | `src/lib/markdown.ts:121-149` | `sanitizeMarkdownHtml` | Synchronous after lazy purifier creation | Entire rendered HTML |
| DOM insertion | `src/components/vault/RenderedMarkdown.vue:58` | `v-html="html"` | Vue update | Sanitized HTML only |

`src/components/vault/ReadingPane.vue:227-233` supplies the normal article surface. `src/components/vault/PdfExportSurface.vue:18-26` reuses `RenderedMarkdown` in an offscreen 720px surface with `render-theme="light"`. `src/main.ts` imports `src/style.css` and KaTeX CSS; it does not currently import Shiki CSS.

The MarkdownIt instance is created once in `mdPromise`. The `render()` API remains async (`Promise<string>`) because initialization is lazy, even though `md.render()` and sanitization are synchronous after initialization.

## 6. Current fence contracts

`buildHighlight()` checks `markmap` and `mermaid` before normal language highlighting. It nevertheless imports highlight.js and both CSS assets before the callback is used. The current normal output contract is:

| Fence | Current behavior |
| --- | --- |
| Known language such as `js`/`javascript` | If `hljs.getLanguage(lang)` succeeds, returns `<pre class="hljs"><code>` containing highlight.js token HTML |
| Unknown language such as `totally-unknown` | Does not throw; returns `<pre class="hljs"><code>` with `escapeHtml(source)` |
| Empty/plain info string | Falls through to the same escaped `<pre class="hljs"><code>` contract |
| `mermaid` | Returns `<div class="mermaid-mount" data-content="${encodeURIComponent(source)}"></div>`; does not call `hljs.highlight` |
| `markmap` | Returns `<div class="markmap-mount" data-content="${encodeURIComponent(source)}"></div>`; does not call `hljs.highlight` |
| Similar names `merm`/`mmap` | Are normal code fences, not special placeholders; current tests pin these negative cases |

The source code and focused tests establish these examples:

````markdown
```js
const x = 1
```
→ normal `<pre class="hljs"><code>…`

```totally-unknown
hello <world>
```
→ escaped text inside `<pre class="hljs"><code>`; no throw

```mermaid
graph TD
A --> B
```
→ encoded `.mermaid-mount` placeholder

```markmap
# Root
## Child
```
→ encoded `.markmap-mount` placeholder
````

Normal code-fence HTML is escaped by highlight.js or `escapeHtml`; final DOMPurify is an additional boundary. The migration must not make unknown source executable or cause an unknown language to dispatch to Mermaid/MarkMap.

## 7. DOMPurify/security baseline

`src/lib/markdown.ts:31-149` creates one lazy DOMPurify instance with the following relevant configuration:

| Setting | Current value/behavior |
| --- | --- |
| `ALLOWED_TAGS` | Explicit Markdown set including `pre`, `code`, `a`, tables, images, headings, math-related structural tags and safe inline tags |
| `ALLOWED_ATTR` | Explicit set including `class`, `id`, `href`, `src`, `data-anchor`, `data-content`, `data-missing`, `data-target`, and accessibility/layout attributes |
| `ALLOW_DATA_ATTR` | `true`, then constrained by a hook |
| `FORBID_ATTR` | **`['style']`** |
| `FORBID_TAGS` | `base`, `embed`, `form`, `iframe`, `link`, `math`, `meta`, `object`, `script`, `style`, `svg` |
| URI policy | Allows safe HTTP(S), mailto, tel, hash and relative forms; rejects unsafe schemes such as `javascript:` |
| Custom hook | Removes `on*` event attributes and retains only Nuvyn-owned data attributes (`data-anchor`, `data-content`, `data-missing`, `data-target`) |

The current Markdown security tests cover raw HTML and assert that:

- `<span style="color:red">hello</span>` loses the author style;
- `onclick`, `onerror` and other event attributes are removed;
- `href="javascript:…"` is rejected;
- scripts, iframes and unsafe SVG-like content do not survive;
- Nuvyn-owned encoded placeholders and approved data attributes survive.

The migration security boundary is frozen at H0:

```text
untrusted: Markdown source, raw author HTML, code-fence source
trusted: bundled Shiki themes, Shiki-generated CSS, Nuvyn integration CSS
```

`FORBID_ATTR: ['style']` must remain unchanged. Shiki token styles must be transformed into classes and trusted CSS outside the sanitized article HTML. H0 made no sanitizer change.

## 8. Mermaid and MarkMap contract

The special fences are deliberately outside the normal code-highlighting contract.

| Contract | Current implementation |
| --- | --- |
| Placeholder classes | `.markmap-mount` and `.mermaid-mount` |
| Source transport | `data-content` containing `encodeURIComponent(source)` |
| MarkMap mount | `src/composables/useMarkmapMount.ts`; selector guards with `:not([data-markmap-mounted])`, decodes content, replaces placeholder with `.markmap-widget-host`, mounts `MarkMap` |
| Mermaid mount | `src/composables/useMermaidMount.ts`; selector guards with `:not([data-mermaid-mounted])`, decodes content, replaces placeholder with `.mermaid-widget-host`, mounts `Mermaid` |
| Widget state | MarkMap uses `data-markmap-state`/ready/error; Mermaid uses `data-mermaid-state`/ready/error |
| RenderedMarkdown integration | `src/components/vault/RenderedMarkdown.vue:25-26` calls both mount composables |
| PDF readiness | `src/lib/pdf-readiness.ts` rejects pending placeholders and accepts settled ready/error widgets |
| PDF behavior | `src/lib/pdfExport.ts` staticizes settled Mermaid/MarkMap in the clone; it does not change the live article or route either fence through Shiki |
| Regression tests | `src/lib/__tests__/markdown.test.ts`, `markmapSecurity.test.ts`, `pdf-readiness.test.ts`, `MarkMap.test.ts`, `Mermaid.test.ts`, plus MarkMap/math and PDF E2E suites |

The `features.hljs` and rendered `hljs` assertion in `markmapSecurity.test.ts` belong to MarkMap’s own `markmap-lib` transformer. They are not evidence that Nuvyn’s normal Markdown renderer still needs a `class="hljs"` after H7. This ownership distinction must be retained in the cleanup audit.

## 9. Theme behavior baseline

The current app does not expose a live three-state `system/light/dark` value. `src/composables/useTheme.ts` has only `Theme = 'light' | 'dark'`:

| Situation | Current behavior |
| --- | --- |
| Saved theme | `index.html` boot script and `useTheme` set concrete `data-theme="light"` or `data-theme="dark"` from `localStorage['nuvyn.theme']` |
| No saved theme | `useTheme` reads `matchMedia('(prefers-color-scheme: dark)')` once, resolves to light/dark, stores that concrete state in the module ref and applies a concrete `data-theme` |
| OS light/dark | Initial CSS media queries can paint from OS preference before app initialization; after `useTheme` applies the concrete attribute, the app does not listen for later OS changes |
| Forced light | `data-theme="light"` wins over OS-dark selectors |
| Forced dark | `data-theme="dark"` forces dark selectors |
| Runtime switch | `set()` writes localStorage and updates the root attribute; `toggle()` flips the two-state value |
| Reload | Saved concrete state is restored by the boot script and composable |

`src/style.css` contains `prefers-color-scheme` defaults and higher-specificity `:root[data-theme='light']`/`:root[data-theme='dark']` variables. `src/hljs-dark.css` uses `:root:not([data-theme='light'])` for OS-dark behavior and `:root[data-theme='dark']` for forced dark, so forced light is protected from the OS-dark block. The light GitHub highlight.js CSS is loaded separately from the dark CSS.

This is a baseline discrepancy to carry into H5 review: the PRD requires system/light/dark theme behavior without Markdown re-tokenization, while the current app snapshots the OS choice into a concrete two-state attribute. H0 records this fact and does not change theme semantics.

## 10. PDF code-block baseline

`src/lib/pdfExport.ts` owns the printable surface CSS and clone lifecycle. The current contract is:

| Area | Current behavior |
| --- | --- |
| Page geometry | A4; `@page` margin `16mm 18mm 18mm`; printable width `174mm`, printable height `263mm` converted with `96/25.4` CSS px per mm |
| Theme | `.pdf-download-root` and `.pdf-document.vault` force printable light/white variables; `PdfExportSurface` renders with `render-theme="light"` |
| Code background/border | Generic `.pdf-document .article pre` uses light `#f5f6f8` background, border and readable text; no `.hljs` selector is required |
| Wrapping | `white-space: pre-wrap`, `overflow-wrap: anywhere`, and code-level `word-break: break-word` |
| Pagination | Normal blocks use `break-inside: avoid` and `page-break-inside: avoid`; measured oversized blocks receive `.pdf-allow-split` and can split |
| Oversized code | Included in the block measurement selector; an oversized code block is allowed to split instead of causing horizontal clipping or an impossible page break |
| Clone/isolation | `preparePdfArticleHtml` clones the article, removes interactive toolbars, staticizes widgets, and does not mutate global `data-theme` |
| CSS ownership | Trusted `PDF_DOWNLOAD_STYLES` is injected into the temporary `.pdf-download-root` style element before `html2pdf`; it is outside sanitized user HTML |
| Cleanup | Temporary host is removed in `finally` after export |
| Existing Shiki/hljs dependency | No PDF-specific `.hljs` or nested token-color rule; PDF currently relies on generic `pre`/`code` rules |

### Surface colors versus syntax-token colors

The current PDF baseline must distinguish the code-block surface from the colors of nested syntax-token spans. `PDF_DOWNLOAD_STYLES` explicitly sets the printable code-block surface and inherited text color through generic selectors equivalent to:

```css
.pdf-document .article pre {
  background: #f5f6f8 !important;
  color: #202124 !important;
}
```

Normal highlight.js output contains nested token elements such as `<span class="hljs-keyword">const</span>`. The dark stylesheet has direct `.hljs-keyword`, `.hljs-string`, `.hljs-comment`, `.hljs-number` and related selectors. Therefore the PDF `pre { color: ... !important }` rule controls the inherited base color but does not by itself override direct colors on nested token spans.

`PdfExportSurface.vue` passes `render-theme="light"` to `RenderedMarkdown`. `RenderedMarkdown` consumes that value through the Mermaid and MarkMap mount composables; it does not mutate `document.documentElement[data-theme]` and does not independently force highlight.js token spans onto the GitHub-light syntax palette. This is a current implementation fact, not a behavior change in H0.

Current PDF code-block baseline:

- code-block surface/background is explicitly printable light;
- generic `pre`/`code` text and wrapping are explicitly controlled;
- PDF CSS does not currently contain dedicated `.hljs` token-color overrides;
- under a dark reader/root theme, nested highlight.js token spans may continue matching the dark highlight.js palette;
- the current PDF E2E baseline proves successful export, layout, theme isolation, widget settlement and pagination, but does not prove that computed syntax-token colors are a GitHub-light palette.

Conclusion: the current highlight.js token palette is **NOT EXPLICITLY FORCED TO LIGHT** and is **NOT CURRENTLY PROVEN BY H0 EVIDENCE**. This does not establish that current PDFs are definitely visually broken; it identifies an unasserted baseline property that H6 must close.

### H6 handoff: computed token-color proof

SHIKI-H6 must prove all of the following in the actual printable surface, not only in the reader:

```text
reader light  → PDF light syntax palette
reader dark   → PDF light syntax palette
forced dark   → PDF light syntax palette
OS dark       → PDF light syntax palette
```

That evidence must inspect actual token computed colors for representative highlighted spans (for example keyword/string/comment tokens), using browser computed-style assertions or equivalent trustworthy evidence. It is insufficient to prove only that the PDF exists, that `pre`/`code` text exists, or that the background is light. H0 does not implement those assertions.

## 11. Test inventory

| Contract | Test file(s) | Current assertion/evidence | H1-H8 relevance |
| --- | --- | --- | --- |
| MarkMap fence | `src/lib/__tests__/markdown.test.ts` | `.markmap-mount`, encoded `data-content`, no raw angle brackets | H3/H7 regression |
| `mmap` negative case | `src/lib/__tests__/markdown.test.ts` | Similar language is not treated as MarkMap | H2/H3 regression |
| Normal highlighted fence | `src/lib/__tests__/markdown.test.ts` | `js` fence contains `class="hljs"` and not MarkMap placeholder | Migrate at H3; current baseline for cutover |
| Mermaid fence | `src/lib/__tests__/markdown.test.ts` | `.mermaid-mount`, encoded source, no MarkMap placeholder | H3/H7 regression |
| `merm` negative case | `src/lib/__tests__/markdown.test.ts` | Similar language is not treated as Mermaid | H2/H3 regression |
| Raw HTML/security | `src/lib/__tests__/markdown.test.ts` | Scripts/iframes/events/javascript URIs removed; safe tags remain | H4 must preserve |
| Data attributes | `src/lib/__tests__/markdown.test.ts` | Only Nuvyn data attributes survive | H4 must preserve |
| Markdown extensions | `src/lib/__tests__/markdown.test.ts`, `callouts.test.ts`, `math.test.ts`, `wikiLinks.test.ts` | Footnotes, definition lists, callouts, math, emoji, links and fenced-code boundaries | H3 must not regress parser behavior |
| Resolver concurrency/isolation | `src/lib/__tests__/markdown.test.ts:181-194` | Concurrent renders keep resolver A/B isolated | H2 must not double-call or share resolver state |
| Async consumer | `src/composables/vault/__tests__/useMarkdownRender.test.ts` | Async render/cancellation and heading behavior | H3 must retain `Promise<string>` |
| MarkMap security | `src/lib/__tests__/markmapSecurity.test.ts` | MarkMap transformer sanitization, trusted KaTeX styles, `features.hljs` internal contract | H4/H7 ownership review |
| Mermaid runtime | `src/lib/__tests__/mermaidRuntime.test.ts`, `Mermaid.test.ts` | Exclusive runtime and widget behavior | H3/H6 regression |
| Widget readiness | `src/lib/__tests__/pdf-readiness.test.ts` | Pending/ready/error placeholder state handling | H6 regression |
| PDF helper | `src/lib/__tests__/pdfExport.test.ts` | A4 styles, generic pre/code wrapping, split marker, clone/staticization/cleanup | H6 Shiki light override |
| PDF surface | `src/components/vault/__tests__/PdfExportSurface.test.ts` | Export surface uses light render theme | H6 |
| Theme visual | `e2e/markdown-visual.spec.ts` | Forced light and forced dark visual cases | H5, add system semantics if required |
| PDF export | `e2e/pdf-export.spec.ts` | Dark reader export, content, widgets, global theme unchanged | H6 |
| PDF layout | `e2e/pdf-export-layout.spec.ts` | Long/oversized code, no horizontal overflow, widget/table layout | H6 |
| PDF pagination | `e2e/pdf-export-pagination.spec.ts` | A4 boundary evidence, avoid/split decisions | H6 |
| PDF stress | `e2e/pdf-export-stress.spec.ts` | 100-page, extreme widgets, wide table, huge code, math and images | H6/H8 |
| Additional PDF suites | `e2e/pdf-export-read-mode.spec.ts`, `pdf-export-compat.spec.ts`, `pdf-export-long-document.spec.ts`, `pdf-export-cors.spec.ts` | Existing export/read-mode/compatibility/long-document/CORS coverage | H6/H8 |
| Separate AI Markdown | `src/lib/aiMarkdown.ts`, `src/lib/__tests__/aiMarkdown.test.ts` | Separate renderer uses `language-ts` contract | Not automatically part of Nuvyn vault migration; review if scope changes |

The only current direct assertion of Nuvyn normal `class="hljs"` is the Markdown test listed above. The MarkMap security assertion is a separate ownership category.

The current PDF E2E suites do not assert that a representative nested highlighted token such as `.hljs-keyword` or `.hljs-string` has the expected printable-light computed color inside the export/download surface. This is an H0 coverage gap carried to H6; the existing export, layout, pagination and stress passes must remain historical evidence for those other contracts.

## 12. Test/build evidence

All baseline commands below ran before the H0 documentation edits. No application behavior was changed between the audited implementation and these checks.

### Typecheck

```text
npm run typecheck → PASS (exit 0)
```

The command completed both client Vue/type checks and server TypeScript checks.

### Focused migration-surface unit tests

```text
./node_modules/.bin/vitest run \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/markmapSecurity.test.ts \
  src/lib/__tests__/pdfExport.test.ts \
  src/lib/__tests__/pdf-readiness.test.ts \
  src/components/vault/__tests__/PdfExportSurface.test.ts \
  src/composables/vault/__tests__/useMarkdownRender.test.ts

Test Files  6 passed (6)
Tests       84 passed (84)
→ PASS (exit 0)
```

### Full unit suite

```text
npm run test:unit → FAIL (exit 1)
Test Files 3 failed | 207 passed (210)
Tests      21 failed | 3054 passed | 2 skipped (3077)
```

The failures were not converted into green evidence:

- 19 failures are in `server/__tests__/openai-http.test.ts` and report `listen EPERM: operation not permitted 127.0.0.1`.
- `server/__tests__/round15FolderMoveRecoveryClosure.test.ts` and `server/__tests__/round16FolderMoveCoordinatorClosure.test.ts` fail their child `tsx` startup/READY path with `listen EPERM` on the temporary IPC pipe under `/var/folders/...`.
- The exact failures are server-only and unrelated to Markdown/highlighting; the evidence identifies this as a baseline environment limitation, not a Shiki regression. `Window's scrollTo()` jsdom warnings were non-failing warnings.

### Production build

```text
npm run build → PASS (exit 0)
Vite/Rolldown: 3721 modules transformed; built in about 1.19s
```

Existing warnings were retained as baseline evidence:

- Rolldown `INVALID_ANNOTATION` warnings for `/* #__PURE__ */` annotations in `node_modules/@vueuse/core/dist/index.js`.
- Existing warning that some chunks exceed 500 kB.

### Browser/E2E baseline

The first default-sandbox Playwright startup could not bind the local preview server (`listen EPERM 127.0.0.1:4174`). With the required approved local process/network permission, the same unchanged tests ran successfully:

```text
e2e/markdown-visual.spec.ts --project=chromium
→ 2 passed (light/dark)

e2e/pdf-export.spec.ts \
e2e/pdf-export-layout.spec.ts \
e2e/pdf-export-pagination.spec.ts --project=chromium
→ 4 passed (export 2, layout 1, pagination 1)

e2e/pdf-export-stress.spec.ts --project=chromium
→ 7 passed
```

Pagination diagnostics recorded a printable page height of `994.015625px`. The boundary probe `H6_BOUNDARY_PROBE_002` crossed a page boundary while retaining `break-inside/page-break-inside: avoid`; this is the current PDF pagination evidence, not a Shiki result.

Stress diagnostics included 160 sections in the 100-page lane, 60 Mermaid nodes, 81 MarkMap nodes, 24 table columns, 601 code lines, 75 KaTeX formulas and 30 loaded images. All seven stress lanes passed.

## 13. Pre-Shiki bundle baseline

This is the production build baseline captured before Shiki was added. Sizes below are the Vite build report values (raw and gzip, rounded as printed):

| Asset/chunk | Raw | Gzip | Purpose/observation |
| --- | ---: | ---: | --- |
| `assets/github-DdKuH37F.css` | 1.06 kB | 0.44 kB | Current highlight.js GitHub light CSS |
| `assets/hljs-dark-Gf5kSmHw.css` | 4.44 kB | 0.72 kB | Current Nuvyn dark highlight.js CSS |
| `assets/markdown-Cimd5fb3.js` | 3.63 kB | 1.34 kB | Markdown/highlighter lazy chunk |
| `assets/index-CP3umf6P.js` | 231.72 kB | 77.95 kB | Main application chunk |
| `assets/VaultView-vg19isgt.js` | 1,712.61 kB | 484.60 kB | Vault view chunk |
| `assets/EditorPane-CzC7jkOt.js` | 3,648.93 kB | 932.79 kB | Editor chunk |
| `assets/es-BJ9eesMT.js` | 914.55 kB | 304.42 kB | Existing dependency chunk |
| `assets/chunk-NNHCCRGN-DlpIbxXb.js` | 593.66 kB | 137.74 kB | Existing dependency chunk |
| `assets/cytoscape.esm-h6BdjjI9.js` | 435.41 kB | 137.93 kB | Existing graph dependency |
| `assets/browser-DVDkpUfh.js` | 391.49 kB | 128.78 kB | Existing browser dependency |

The build also emitted other existing worker/dependency chunks and the 500 kB warning. The `dist/` output is ignored and was not committed. H8 must compare against this exact pre-Shiki evidence and verify that Shiki language grammars remain lazy; H0 does not optimize or set a zero-growth requirement.

## 14. Double-parse risk findings

The implementation plan proposes discovering fence languages with MarkdownIt parsing before the final synchronous render. H0 inspected the current plugins and render-scoped environment.

Findings:

1. `src/lib/wikiLinks.ts:129-155` invokes the resolver from `state.env` during inline parse for wiki links.
2. `src/lib/wikiLinks.ts:215-223` can invoke the resolver again in the `link_open` renderer override for standard internal links.
3. The current `render()` creates a per-render `{ wikiResolver: options.resolver }` environment and calls `md.render()` once, which preserves resolver isolation.
4. A naïve `md.parse(markdown, sameEnv)` followed by `md.render(markdown, sameEnv)` would therefore call a user resolver during preflight and again during final render. This is an observable double-call and can change resolver side effects/performance.
5. Callouts, math, anchor generation, task lists, footnotes, definition lists, mark and emoji operate on per-render tokens/meta; no module-global mutation was found that would make the current single render unsafe.
6. MarkMap/Mermaid placeholders are produced by the fence renderer callback, not by the parse phase.

This is an **H2 design blocker**, not an H0 implementation change. Before H2 adopts preflight parsing, it must choose a safe scanner or an env/plugin seam that cannot call the user resolver twice, and review the resulting architecture against the PRD. H0 did not introduce double parsing.

## 15. Future migration surface

The following is an audit prediction for later review, not permission to edit these files during H0.

### H1 — Dependency & Runtime Foundation

```text
package.json
package-lock.json
src/lib/shiki.ts (or the reviewed focused runtime module)
new Shiki runtime tests
```

### H2 — Fence Discovery & Dynamic Language Loading

```text
src/lib/shiki.ts
src/lib/markdown.ts
language discovery, alias, concurrency and unknown-language tests
```

The H2 double-parse blocker above must be resolved before behavior is implemented.

### H3 — Markdown Renderer Cutover

```text
src/lib/markdown.ts
src/lib/__tests__/markdown.test.ts
renderer/fence contract tests
```

Normal fences change from the highlight.js callback only here. MarkMap, Mermaid, the async API and sanitizer remain in scope as preserved contracts.

### H4 — Style-to-Class & Security Closure

```text
src/lib/shiki.ts (or reviewed runtime module)
Markdown/security tests
```

The proof target is class-based Shiki output with `FORBID_ATTR: ['style']` unchanged.

### H5 — Theme Integration

```text
src/shiki.css (or the location approved after inspecting style ownership)
src/main.ts or the reviewed CSS entry
theme tests and Markdown visual E2E
```

H5 must reconcile the PRD’s system/light/dark requirement with the current concrete two-state `data-theme` behavior without rerendering Markdown on theme switch.

### H6 — PDF Compatibility

```text
src/lib/pdfExport.ts
src/lib/__tests__/pdfExport.test.ts
PDF surface and PDF E2E suites
```

The existing generic `pre`/`code` wrapping, static widget, clone isolation and pagination contracts must remain. H6 must additionally prove the actual computed colors of representative Shiki token spans for reader light, reader dark, forced dark and OS dark, with the PDF palette light in every case.

### H7 — Cleanup & highlight.js Removal

```text
package.json
package-lock.json (and package-manager lock policy as applicable)
src/hljs-dark.css
old Nuvyn highlight.js imports/comments/tests
server/ai/prompt.md if product wording is still stale
```

H7 must separately account for MarkMap-owned `features.hljs`, transitive MarkMap dependency entries and historical documents. It must not use a blind zero-hit grep as the only criterion.

### H8 — Full Regression, Bundle Audit & Release Gate

```text
test/build/E2E evidence and release documentation
```

No H1-H8 implementation was started in this audit.

## 16. Known pre-existing failures and environment limitations

| Finding | Evidence | Handling |
| --- | --- | --- |
| Full unit suite cannot bind server test listeners in this environment | 21 failures with `listen EPERM` in OpenAI HTTP and two folder-move recovery/coordinator tests | Record `npm run test:unit` as FAIL; do not call it green; rerun in CI/approved environment before release comparison |
| Default-sandbox Playwright server cannot bind `127.0.0.1:4174` | Initial browser run failed before tests with `listen EPERM` | Re-run with approved local permission; focused Markdown/PDF/E2E tests then passed |
| Local Node differs from container | Local Node 24.15.0; Dockerfile Node 22 | Preserve both versions in future comparison evidence |
| pnpm lock importer has unrelated better-sqlite3 drift | `pnpm-lock.yaml` differs from package manifest/npm lock | Do not repair during Shiki H0; review separately |
| H2 same-env MarkdownIt preflight can double-call wiki resolver | Source inspection of `wikiLinks.ts` parse and renderer paths | Carry as explicit H2 design blocker; no implementation workaround in H0 |
| Current theme is two-state after OS snapshot, not a live system state | `useTheme.ts`, `index.html`, `style.css` inspection | Carry as H5 baseline/product-semantics review item; no H0 theme change |

No Shiki-specific failure exists because Shiki is not installed and the renderer was not changed.

## 17. H0 exit criteria

- [x] Actual HEAD, branch state and local/container runtime recorded.
- [x] Dependency baseline recorded; Shiki and `@shikijs/transformers` confirmed absent.
- [x] `highlight.js`/`hljs` references inventoried and classified, including MarkMap ownership.
- [x] Real Markdown rendering pipeline documented from source to `v-html`.
- [x] Normal, unknown, empty, Mermaid and MarkMap fence contracts documented.
- [x] DOMPurify security boundary documented; `FORBID_ATTR: ['style']` confirmed and frozen.
- [x] Current theme semantics and highlight.js CSS precedence documented.
- [x] PDF code-block surface, clone, light-theme, wrapping and pagination behavior documented, including the current syntax-token color proof gap.
- [x] Migration-relevant unit, component, visual and PDF tests mapped.
- [x] `npm run typecheck` result recorded as PASS.
- [x] `npm run test:unit` result recorded honestly as FAIL with exact failure signature.
- [x] `npm run build` result recorded as PASS with existing warnings.
- [x] Focused Markdown/PDF unit and relevant browser baselines recorded.
- [x] Pre-Shiki bundle baseline captured.
- [x] MarkdownIt double-parse risk inspected and carried forward as an H2 blocker.
- [x] Future H1-H8 file surface documented.
- [x] No Shiki dependency was added; highlight.js remains active.
- [x] No application behavior or production source changed.
- [x] H0 evidence is durable in this document; H1-H8 are not marked complete.

H0 is complete as an evidence phase. The two design findings in Section 16 are explicit follow-up inputs, not omitted audit areas. The next planned phase is H1 only after the H2 discovery design blocker is reviewed before H2 implementation.

## 18. H0 handoff

```text
PRD: CLEAN
Implementation Plan: H0 COMPLETE
H0 Audit: CLARIFIED
Implementation baseline: 2be6b2c57b5d7cb76b359220f361bacb55661099
Audit HEAD: dd6281a085341e09d599f4ddae45cf0661206e81
H0 completion commit: f9e02270d235fb1eb01ab5ee796322249a1506fe
Shiki implementation: NOT STARTED
highlight.js renderer: STILL ACTIVE
Next planned phase: SHIKI-H1 — Dependency & Runtime Foundation
```

Before H2 implementation begins, review the same-environment `md.parse()`/`md.render()` resolver double-call risk recorded above. No H1 work is included in this commit.
