# Nuvyn VitePress-Style Markdown Extensions
# MD-EXT-7 — Full Regression, Bundle Audit & Release Gate

## 1. Phase metadata

| Field | Value |
| --- | --- |
| Phase | MD-EXT-7 — Full Regression, Bundle Audit & Release Gate |
| Status | COMPLETE / REVIEW-CLOSED |
| Release gate | PASS |
| Program status | COMPLETE / REVIEW-CLOSED |
| Repository | `tangxiangxiang/nuvyn` |
| Branch | `main` |
| MD-EXT-7 base | `810ad55941d2a5df8a91d5728d51ebbeb0196aa3` |
| MD-EXT-6 final production SHA | `fc78da8b0dd23e5b543ed346b5bf63032778c181` |
| MD-EXT-6 lifecycle closure | `810ad55941d2a5df8a91d5728d51ebbeb0196aa3` |
| Approved PRD | `7e05e3bb43f4283a90ead1abd0c81325bc93281c` |
| Immutable Implementation Plan baseline | `582e312a4c5752a4c9a5c6bba7b0e752b0b78078` |
| Shiki H0-H8 release closure | `c32f5bc9c1597c6c2f6b3e9581f327636fe8d8c2` |
| Parser runtime | `markdown-it 14.2.0` (package range `^14.1.0`), singleton |
| Evidence date | 2026-08-23 |
| MD-EXT-7 completion commit | `6306e053f73f595c9326ecdd80212cff27399f2b` |

MD-EXT-0 through MD-EXT-6 are closed. This document records the final local release
gate result and the externally approved program closure; it does not claim
independent GitHub status checks.

## 2. Environment inventory

| Item | Observed value |
| --- | --- |
| Host | Darwin 25.5.0, arm64 |
| Node | `v24.15.0` |
| npm | `11.12.1` |
| git | `2.50.1` |
| Package manager | npm |
| Canonical lockfile | `package-lock.json` |
| Browser | Chromium via `@playwright/test 1.61.1` |

Resolved package versions:

| Package | Resolved version |
| --- | ---: |
| `markdown-it` | 14.2.0 |
| `markdown-it-anchor` | 9.2.0 |
| `shiki` | 4.4.3 |
| `@shikijs/transformers` | 4.4.3 |
| `dompurify` | 3.4.10 |
| `vite` | 8.0.16 |
| `typescript` | 6.0.3 |
| `vitest` | 4.1.8 |
| `@playwright/test` | 1.61.1 |
| `highlight.js` | 11.11.1, transitive through `markmap-lib` only |

`vitepress`, `@vitepress/*`, `markdown-it-attrs`, `markdown-it-container`, and an
MDX runtime are absent from the dependency tree. `npm ci` was not run because this
was the developer workspace; no dependency or lockfile mutation was made.

## 3. Phase closure chain

All listed commits exist and are ancestors of the MD-EXT-7 base. The phase evidence
documents intentionally retain non-self-referential historical completion placeholders
where the completion commit was not known while that document was created. The chain
below is therefore verified from the subsequent phase-base metadata and git history;
history was not rewritten.

| Phase / boundary | Verified SHA | Evidence relationship |
| --- | --- | --- |
| MD-EXT-0 evidence | `579bda1850ceb955eb0796fec2cc3ec919b72a21` | MD-EXT-1 base |
| MD-EXT-1 final review follow-up | `4c86783fc847fda43a5eaba95e1d32621d79b835` | MD-EXT-2 base |
| MD-EXT-2 final review follow-up | `aaac9a54a047e504850d497533216d2851c4e928` | MD-EXT-3 base |
| MD-EXT-3 final review follow-up | `953150f64259b7af389ec0e111d161c9af20b7c7` | MD-EXT-4 base |
| MD-EXT-4 final review follow-up | `57919e17e61bb10aea8530093386562d2ac02062` | MD-EXT-5 base |
| MD-EXT-5 final review follow-up | `dd4768f67e77f190794cd7d046218705e2ce56e3` | MD-EXT-6 base |
| MD-EXT-6 final production | `fc78da8b0dd23e5b543ed346b5bf63032778c181` | last product commit |
| MD-EXT-6 lifecycle closure / MD-EXT-7 base | `810ad55941d2a5df8a91d5728d51ebbeb0196aa3` | docs-only base |

All phase evidence files are present:

```text
docs/design/vitepress-markdown-extensions-md-ext-0-audit.md
docs/design/vitepress-markdown-extensions-md-ext-1-anchors-toc-links-images.md
docs/design/vitepress-markdown-extensions-md-ext-2-containers.md
docs/design/vitepress-markdown-extensions-md-ext-3-code-annotations.md
docs/design/vitepress-markdown-extensions-md-ext-4-line-numbers.md
docs/design/vitepress-markdown-extensions-md-ext-5-code-groups.md
docs/design/vitepress-markdown-extensions-md-ext-6-resources.md
docs/design/vitepress-markdown-extensions-md-ext-7-release-gate.md
```

## 4. Release commands and results

Every final release command below was run in an environment permitting local
loopback and `tsx` IPC. Exit code was 0 for each command.

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run typecheck` | 0 | PASS — client and server checks |
| `npm run test:unit` | 0 | PASS — 218 files, 3,250 passed, 2 skipped |
| `npm run test:history-integration` | 0 | PASS — 5 files, 172 tests |
| `npm run test:recovery-integration` | 0 | PASS — 5 files, 193 tests |
| `npm test` | 0 | PASS — aggregate unit/history/recovery scripts |
| `rm -rf dist && npm run build` | 0 | PASS — 3,937 modules transformed |

The first restricted-sandbox unit attempt reproduced the historical environment
signature (`19` loopback `listen EPERM` failures and two `tsx` IPC `EPERM` failures).
It was not used as the release result. The permitted rerun passed all 3,250 unit
tests, so the final release ledger has no environment failure.

The unit run emitted only existing test-environment notices about jsdom
`scrollTo()`, canvas `getContext()`, and CSS parsing. The build emitted the known
`@vueuse/core` `INVALID_ANNOTATION` warning and the existing large-chunk warning;
no new MD-EXT-specific warning class was introduced.

Focused release unit command:

```text
./node_modules/.bin/vitest run src/lib/__tests__/markdown.test.ts src/lib/__tests__/callouts.test.ts src/lib/__tests__/fenceMeta.test.ts src/lib/__tests__/shiki.test.ts src/lib/__tests__/markdownCodeGroups.test.ts src/lib/__tests__/markdownContainers.test.ts src/lib/__tests__/markdownInlineSource.test.ts src/lib/__tests__/markdownResources.test.ts src/lib/__tests__/wikiLinks.test.ts src/lib/__tests__/math.test.ts src/lib/__tests__/markmapSecurity.test.ts src/lib/__tests__/mermaidRuntime.test.ts src/lib/__tests__/aiMarkdown.test.ts src/lib/__tests__/pdfExport.test.ts src/lib/__tests__/pdf-readiness.test.ts src/lib/__tests__/pdf-images.test.ts src/composables/vault/__tests__/useMarkdownRender.test.ts src/composables/__tests__/useCodeGroupMount.test.ts src/components/vault/__tests__/PdfExportSurface.test.ts server/__tests__/paths.test.ts server/routes/markdownResources.test.ts server/__tests__/auth-middleware.test.ts
```

Result: exit 0, 22 files, 369 tests PASS.

## 5. Browser and PDF evidence

All browser commands used Chromium, one worker, exit code 0, and no retries.
The only browser process notices were `NO_COLOR` being ignored because
`FORCE_COLOR` was set by the test runner.

| Command / suite | Result |
| --- | --- |
| MD-EXT-1 through MD-EXT-6 phase specs | PASS — 16/16 |
| `markdown-shiki-security`, `markdown-shiki-theme`, `pdf-export-shiki` | PASS — 3/3 |
| Markdown visual, MarkMap/math, compatibility/CORS/layout/long-document/pagination/stress/general PDF | PASS — 22/22 |

The combined browser evidence is 41/41 PASS. The phase suite proves final IDs/TOC,
containers/details, annotations, bounded line numbers, code groups, resource
expansion/source context, theme identity, and local-image PDF no-reread/fail-closed
behavior. The Shiki/PDF suite proves computed printable-light token colors across
explicit light/dark, OS light/dark, and no-attribute OS-dark cases. The PDF group
fixture keeps a non-default reader tab selected while exporting all panels in source
order, including visible line numbers and annotation classes.

Manual acceptance was substituted by these exact browser assertions: the visual
Markdown spec covers light/dark reader surfaces; MD-EXT-2 covers native details;
MD-EXT-4 covers copy/wrapping/theme-safe gutters; MD-EXT-5 covers mouse/keyboard,
ARIA, multiple groups, cleanup, and theme identity; MD-EXT-6 covers included
headings/TOC, source-aware links, snippets, groups, resource images, and PDF clone
isolation; the PDF suites cover printable output, pagination, Mermaid, MarkMap,
math, images, and stress tails. No separate manual GUI claim is made.

## 6. Cross-phase compatibility matrix

| Feature | Owner phase | Unit | E2E | Security | PDF | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Heading IDs and auto/custom collisions | MD-EXT-1 | PASS | PASS | PASS | PASS | CLOSED |
| `[[toc]]` and final IDs | MD-EXT-1 | PASS | PASS | PASS | PASS | CLOSED |
| Generated external links | MD-EXT-1 | PASS | PASS | PASS | PASS | CLOSED |
| Lazy Markdown images | MD-EXT-1 | PASS | PASS | PASS | PASS | CLOSED |
| Built-in containers/details | MD-EXT-2 | PASS | PASS | PASS | PASS | CLOSED |
| FenceMeta and special-fence exactness | MD-EXT-3 | PASS | PASS | PASS | PASS | CLOSED |
| Shiki source annotations | MD-EXT-3 | PASS | PASS | PASS | PASS | CLOSED |
| Deferred `highlight:N` | MD-EXT-3 | PASS | PASS | PASS | OUT OF SCOPE | ABSENT |
| Structural line numbers | MD-EXT-4 | PASS | PASS | PASS | PASS | CLOSED |
| Static accessible code groups | MD-EXT-5 | PASS | PASS | PASS | PASS | CLOSED |
| Logical resource paths | MD-EXT-6 | PASS | PASS | PASS | PASS | CLOSED |
| Physical resource/auth boundary | MD-EXT-6 | PASS | PASS | PASS | PASS | CLOSED |
| Include source context | MD-EXT-6 | PASS | PASS | PASS | PASS | CLOSED |
| Cycle/depth/size/budget | MD-EXT-6 | PASS | PASS | PASS | PASS | CLOSED |
| Mermaid, MarkMap, and math | Baseline / MD-EXT-0 | PASS | PASS | PASS | PASS | CLOSED |
| Shiki singleton and generated CSS owner | H8 / MD-EXT-0 | PASS | PASS | PASS | PASS | CLOSED |

The included-content fixture proves an included heading participates in the shared
slug allocator and TOC, an included Python/TypeScript fence is discovered after
expansion, source-aware links remain relative to the included file, and an included
code group remains mountable. The MD-EXT-5 PDF fixture proves annotated numbered
code inside a group. The MD-EXT-6 fixture proves resource-expanded content and PDF
resource isolation. No second parser, slugger, resolver state, or highlighter is
introduced by these combinations.

## 7. Security and sanitizer ledger

| Boundary | Positive proof | Negative proof | Result |
| --- | --- | --- | --- |
| DOMPurify style/events | Sanitized generated Markdown | `style`, event handlers, script/style tags removed | PASS |
| Dangerous URI policy | Approved HTTP(S), vault, fragment, and relative links | unsafe URI schemes rejected | PASS |
| External-link provenance | Generated HTTP(S) links retain target/rel | forged public marker/class cannot grant trust | PASS |
| Heading grammar | Narrow `{#safe-id}` works | generic attrs/class/style/event forms absent | PASS |
| Container attrs | Five fixed types/details `{open}` work | arbitrary types and attrs absent | PASS |
| Code-group ARIA/tabindex | Static tabs retain reviewed ARIA and `0`/`-1` | invalid tabindex/data/event/style values removed | PASS |
| Resource auth/root/path | Authenticated canonical resource reads | traversal, absolute, protocol, and root escape rejected | PASS |
| Symlink/race confinement | Safe physical reads | symlink/junction/race escapes rejected | PASS |
| UTF-8/type/size | Approved text/image extensions and bounded reads | binary/invalid UTF-8/oversize inputs fail generically | PASS |
| Cycle/depth/amplification | Per-render stack/cache and depth 8 | cycles/depth/budget violations do not expand | PASS |
| SSRF and disclosure | Local authenticated endpoint only | remote resource reads and host/stack disclosure absent | PASS |
| PDF resource reread | Settled local images snapshot once | endpoint source absent after normal/failure clone | PASS |
| PDF active-tab export | All code-group panels exported in source order | active reader tab cannot hide panels | PASS |

Final sanitizer invariants are unchanged from the reviewed phase ledger:
`FORBID_ATTR: ['style']`, no wildcard data attributes, no author event handlers,
and `tabindex` is retained only for exact generated values `0` and `-1`.

## 8. Architecture and state audit

| Invariant | Result |
| --- | --- |
| Main vault/document MarkdownIt singleton | PASS — `src/lib/markdown.ts` owns the one main instance |
| Intentional isolated AI MarkdownIt surface | PASS — `src/lib/aiMarkdown.ts`, unchanged and separately scoped |
| Per-render resource/source/cache/cycle state | PASS |
| No global heading allocator or code-group active state | PASS |
| One main Shiki highlighter | PASS |
| One `transformerStyleToClass`/generated CSS owner | PASS |
| Lazy Shiki grammar/theme chunks | PASS |
| CSS-only theme switching / no retokenization | PASS |
| Mermaid/MarkMap/math mount cleanup | PASS |
| No second MarkdownIt/highlighter introduced | PASS |
| No H9 Shiki phase or migration reopening | PASS |

Static source inspection finds only the intended `new MarkdownIt` calls in the main
document renderer and isolated `aiMarkdown` surface, the approved Shiki factory and
style transformer, and the approved `codeToHtml` owner. Existing filenames and
diagnostic labels containing `h9` belong to the pre-existing PDF compatibility/stress
test surface; no `SHIKI-H9` phase or implementation exists.

## 9. Bundle audit

Current gzip values below use a deterministic Node `zlib.gzipSync` level-9 measurement
over the final `dist/assets` files. MD-EXT-0 values are preserved historical evidence;
raw-size comparison is exact and gzip deltas are directional rather than a new hard
threshold.

| Surface | MD-EXT-0 raw | MD-EXT-0 gzip | MD-EXT-7 raw | MD-EXT-7 gzip | Delta | Explanation | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| EditorPane | 3,648,931 | 921,510 | 3,648,931 | 919,239 | raw 0 / gzip -2,271 | unchanged editor surface | PASS |
| VaultView | 1,867,839 | 527,445 | 1,920,196 | 543,329 | raw +52,357 / gzip +15,884 | approved reader extensions and PDF/resource integration | PASS |
| application entry | 231,721 | 77,312 | 231,721 | 77,164 | raw 0 / gzip -148 | unchanged entry surface | PASS |
| main CSS | 133,950 | 27,093 | 138,282 | 27,653 | raw +4,332 / gzip +560 | approved reader/PDF extension styles | PASS |
| github-light | 11,181 | 2,543 | 11,181 | 2,481 | raw 0 / gzip -62 | separate Shiki theme chunk | PASS |
| github-dark | 11,402 | 2,581 | 11,402 | 2,522 | raw 0 / gzip -59 | separate Shiki theme chunk | PASS |
| JavaScript grammar | 174,882 | 16,667 | 174,882 | 16,184 | raw 0 / gzip -483 | lazy grammar chunk | PASS |
| TypeScript grammar | 181,135 | 16,176 | 181,135 | 15,742 | raw 0 / gzip -434 | lazy grammar chunk | PASS |
| Python grammar | 69,945 | 9,169 | 69,945 | 9,033 | raw 0 / gzip -136 | lazy grammar chunk | PASS |
| Java grammar | 27,274 | 4,333 | 27,274 | 4,281 | raw 0 / gzip -52 | lazy grammar chunk | PASS |
| SQL grammar | 23,483 | 7,506 | 23,483 | 7,453 | raw 0 / gzip -53 | lazy grammar chunk | PASS |

Final asset inventory:

```text
assets: 467
JavaScript assets: 404
CSS assets: 3
```

Largest JavaScript assets (raw / gzip level 9 bytes):

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| `EditorPane-BvPSMjp0.js` | 3,648,931 | 919,239 |
| `VaultView-DhhRhRhT.js` | 1,920,196 | 543,329 |
| `emacs-lisp-c_oH4hRZ.js` | 790,000 | 198,759 |
| `cpp-HezHOwlx.js` | 785,530 | 51,852 |
| `wasm-BnjxR4X6.js` | 622,325 | 230,136 |
| `chunk-NNHCCRGN-DlpIbxXb.js` | 593,667 | 136,302 |
| `cytoscape.esm-h6BdjjI9.js` | 435,413 | 136,635 |
| `browser-BCYUGutQ.js` | 391,497 | 127,388 |
| `editor.worker-Cn2oRESe.js` | 279,948 | 85,716 |
| `wolfram-DLL8P-h_.js` | 262,384 | 77,051 |
| `index-D6mxfXp9.js` | 231,721 | 77,164 |
| `browser-BQfu9jo4.js` | 206,343 | 76,531 |
| `chunk-CSCIHK7Q-C4i-FkAC.js` | 202,680 | 23,223 |
| `vue-vine-BEaIQIlA.js` | 190,058 | 17,622 |
| `angular-ts-CD_OonCa.js` | 183,731 | 16,239 |
| `typescript-C17ZkDe8.js` | 181,135 | 15,742 |
| `jsx-CZjSJa1f.js` | 177,847 | 16,277 |
| `tsx-MJ0-9sYG.js` | 175,591 | 16,180 |
| `javascript-Cb010CKM.js` | 174,882 | 16,184 |
| `objective-cpp-BsSzOQcm.js` | 171,965 | 30,388 |

The bundle contains separate grammar and theme assets rather than an eager
all-language catalog. It contains zero matches for `readSafeRelativeFile`,
`resolveSafeRelativePathDetailed`, `CONTENT_DIR`, `node:fs`, `fs/promises`,
`server/paths`, VitePress, `markdown-it-attrs`, `markdown-it-container`, or a
Vue-in-Markdown runtime. The transitive `mdx`-named grammar chunk is a language
grammar asset, not an MDX runtime.

## 10. Deferred and rejected feature ledger

| Feature | State | Release treatment |
| --- | --- | --- |
| `[!code highlight:N]` | DEFERRED | OUT OF RELEASE SCOPE; absent |
| Heading/section include | DEFERRED | OUT OF RELEASE SCOPE; absent |
| Code-file include inside fences | DEFERRED | OUT OF RELEASE SCOPE; absent |
| Arbitrary custom container registration | DEFERRED | OUT OF RELEASE SCOPE; absent |
| Generic attrs | REJECTED | Must remain absent; PASS |
| `::: raw` | REJECTED | Must remain absent; PASS |
| Vue-in-Markdown | REJECTED | Must remain absent; PASS |
| VitePress routing/page suffix | REJECTED | Must remain absent; PASS |
| Remote resources | REJECTED | Must remain absent; PASS |

## 11. Failure ledger

```text
Product failures: NONE
Final environment failures: NONE
New MD-EXT build warnings: NONE
Known build warnings: @vueuse/core INVALID_ANNOTATION; existing >500 kB chunk warning
Skipped release-critical tests: NONE
Unit skips: 2 non-release-critical tests in the standard unit suite
```

The historical MD-EXT-6 result remains context only:
`215` files passed, `3,229` tests passed, `21` known EPERM failures, and `2`
skipped. It is not used as the MD-EXT-7 verdict. The authorized rerun above is the
actual final release result.

No independent GitHub status/workflow evidence was available for this final SHA.
This release-gate result is based on the reviewed commit chain, local validation,
and the recorded browser/PDF/bundle/security evidence.

## 12. Release verdict

All release-critical gates passed:

```text
MD-EXT-7 — COMPLETE / REVIEW-CLOSED
Release gate — PASS
MD-EXT PROGRAM — COMPLETE / REVIEW-CLOSED
```

External review approved the final lifecycle closure. MD-EXT-7 introduces no
feature code, no production behavior change, no dependency change, and no H9.

## Final external review closure

| Field | Final state |
| --- | --- |
| MD-EXT-7 | COMPLETE / REVIEW-CLOSED |
| Release gate | PASS |
| External review | APPROVED |
| P0 / P1 / P2 | NONE / NONE / NONE |
| MD-EXT PROGRAM | COMPLETE / REVIEW-CLOSED |
| Final production SHA | `fc78da8b0dd23e5b543ed346b5bf63032778c181` |
| Final release-gate SHA | `6306e053f73f595c9326ecdd80212cff27399f2b` |

No MD-EXT-8 phase or H9 phase is planned by this program. Future Markdown
features require a new independently approved scope/PRD.

## 13. Final references

```text
MD-EXT-0 evidence:
579bda1850ceb955eb0796fec2cc3ec919b72a21

MD-EXT-1 final review follow-up:
4c86783fc847fda43a5eaba95e1d32621d79b835

MD-EXT-2 final review follow-up:
aaac9a54a047e504850d497533216d2851c4e928

MD-EXT-3 final review follow-up:
953150f64259b7af389ec0e111d161c9af20b7c7

MD-EXT-4 final review follow-up:
57919e17e61bb10aea8530093386562d2ac02062

MD-EXT-5 final review follow-up:
dd4768f67e77f190794cd7d046218705e2ce56e3

MD-EXT-6 final production:
fc78da8b0dd23e5b543ed346b5bf63032778c181

MD-EXT-6 lifecycle closure / MD-EXT-7 base:
810ad55941d2a5df8a91d5728d51ebbeb0196aa3

MD-EXT-7 release-gate evidence:
6306e053f73f595c9326ecdd80212cff27399f2b
```
