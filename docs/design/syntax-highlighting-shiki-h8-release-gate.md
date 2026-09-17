# Nuvyn Shiki H8 — Full Regression, Bundle Audit & Release Gate

本记录是 SHIKI-H8 的最终 release-gate evidence。H8 不增加产品能力，
不重写 renderer、theme、PDF 或 Shiki runtime；它复核 H0-H7 的实现合同，
执行全量回归、依赖/ownership audit 和 production bundle audit，并依据 PRD
Definition of Done 给出最终发布结论。

## 1. Release metadata

| 项目 | Evidence |
| --- | --- |
| Phase | `SHIKI-H8 — COMPLETE` |
| H8 base / H7 completion | `d584abf2c64b8b46767cba72fbfc22f5b6606798` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| H7 implementation commit | `d584abf2c64b8b46767cba72fbfc22f5b6606798` |
| H8 implementation commit | Recorded in the final handoff after this evidence document is created |
| Local evidence runtime | Node `v24.15.0`, npm `11.12.1` |
| Docker runtime baseline | `node:22-bookworm-slim` in `Dockerfile` |
| Canonical package manager | npm + `package-lock.json` |
| Status | `PASS`; migration complete |
| Next phase | None; there is no H9 |

The working tree was clean at H8 start. The immutable H8 base was:

```text
d584abf2c64b8b46767cba72fbfc22f5b6606798
```

The historical implementation baseline was not rewritten. H8 evidence was
collected on current main at the H7 completion commit, then the release-only
documentation and package-manager cleanup changes were made.

## 2. H0-H7 phase inventory

| Phase | Result | Core proof |
| --- | --- | --- |
| H0 | COMPLETE | baseline/contracts, sanitizer, themes, PDF and double-parse audit |
| H1 | COMPLETE | Shiki 4.4.3 runtime singleton, dual themes and transformer foundation |
| H2 | COMPLETE | MarkdownIt fence discovery, official registry, aliases, lazy language preparation and resolver isolation |
| H3 | COMPLETE | normal Markdown renderer cut over to synchronous Shiki `codeToHtml()` |
| H4 | COMPLETE | `transformerStyleToClass`, trusted CSS owner and DOMPurify security closure |
| H5 | COMPLETE | CSS-only reader light/dark and forced-theme behavior |
| H6 | COMPLETE | printable-light PDF snapshot/clone/token-color proof |
| H7 | COMPLETE | Nuvyn direct highlight.js dependency and legacy CSS removed; MarkMap transitive ownership preserved |
| H8 | PASS | full regression, bundle audit, lockfile policy and PRD release gate |

Historical phase evidence remains in the H0-H7 documents. H8 does not rewrite
earlier statements that were accurate at their respective phase commits.

## 3. PRD Definition of Done

Every PRD §22 item has a concrete result:

| Requirement | Status | Evidence |
| --- | --- | --- |
| `highlight.js` dependency removed | PASS | `package.json`, npm root lock audit and `npm explain highlight.js` |
| Shiki 4.x installed | PASS | `npm ls shiki` → `4.4.3` |
| Shiki highlighter singleton/cached | PASS | one production `createHighlighter` path in `src/lib/shiki.ts`; H1/H2 tests |
| Languages do not eagerly load the entire catalog | PASS | H2 runtime tests start with no languages; clean build has separate grammar assets |
| GitHub Light + GitHub Dark themes work | PASS | H5 theme browser test and H6 PDF computed-color test |
| Nuvyn system/forced theme behavior works | PASS | `e2e/markdown-shiki-theme.spec.ts`, six selector cases and CSS-only switch |
| No Shiki inline styles survive Markdown HTML | PASS | H4 security unit/browser tests; `e2e/markdown-shiki-security.spec.ts` |
| DOMPurify security policy is not weakened | PASS | `FORBID_ATTR: ['style']` unchanged at `src/lib/markdown.ts:116`; security matrix |
| `transformerStyleToClass` safe class-based approach is used | PASS | one production transformer in `src/lib/shiki.ts`; `nuvyn-shiki-*` classes |
| Generated Shiki CSS is deduplicated | PASS | one `style#nuvyn-shiki-generated-styles`; snapshot replacement tests |
| Unknown languages fall back to escaped plain code | PASS | Markdown unit tests, theme browser test and PDF fixture |
| MarkMap works as before | PASS | MarkMap unit/component/math/PDF stress regressions |
| Mermaid works as before | PASS | Mermaid component, Markdown and PDF stress regressions |
| PDF code blocks remain readable/printable | PASS | PDF light token, wrapping, pagination and stress suites |
| PDF always uses the light syntax palette | PASS | five-case `e2e/pdf-export-shiki.spec.ts` computed-color matrix |
| No `.hljs` application CSS remains | PASS | `src/hljs-dark.css` absent; CSS search returns zero |
| No Nuvyn `highlight.js` runtime imports remain | PASS | production `src` ownership search returns zero |
| Existing Markdown tests pass | PASS | extended client suite and `npm test` |
| New Shiki regression tests pass | PASS | focused H7/H8 set: 10 files, 162 tests |
| `npm run typecheck` passes | PASS | clean post-`npm ci` run |
| `npm run test:unit` passes | PASS | 211 files, 3119 passed, 2 skipped |
| `npm run build` passes | PASS | clean build, 3930 modules transformed |

All release-critical PRD items are `PASS`; no item is `FAIL` or `NOT VERIFIED`.

## 4. Dependency graph

The canonical npm audit after `npm ci` was:

```text
nuvyn@0.0.0
├── @shikijs/transformers@4.4.3
├─┬ markmap-lib@0.18.12
│ └── highlight.js@11.11.1
└── shiki@4.4.3
```

`npm explain highlight.js` shows only:

```text
highlight.js@11.11.1
node_modules/highlight.js
  highlight.js@"^11.8.0" from markmap-lib@0.18.12
  markmap-lib@"^0.18.12" from the root project
```

The package and lock invariants are:

```text
package.json shiki                  → ^4.4.3
package.json @shikijs/transformers  → ^4.4.3
package.json direct highlight.js    → absent
package-lock root highlight.js edge → absent
MarkMap transitive highlight.js      → present, expected
```

No dependency version was upgraded during H8. `npm ci` succeeded and rebuilt
the canonical npm tree from the committed npm lock.

## 5. Package-manager / lockfile decision

The H8 audit searched the live repository workflow, CI, Dockerfile, scripts,
README and development/deployment documentation. The result is npm-only:

- `.github/workflows/ci.yml` uses `npm ci`, `npm test`, `npm run build` and npm cache;
- `Dockerfile` copies `package-lock.json` and runs `npm ci`;
- README, setup, installation, deployment and CI documentation require npm;
- `package.json` has no `packageManager` field;
- `playwright.config.ts` uses the Node executable directly; its pnpm mention is only a comment about compatible node_modules layouts;
- remaining pnpm references are archived plans/specifications or historical evidence, not live consumers.

Therefore H8 applied the permitted Case A decision:

```text
pnpm-lock.yaml: REMOVED

Reason:
the repository audit proves npm + package-lock.json is the only live
reproducible workflow; tracked pnpm-lock.yaml was broadly stale and had no
live CI, Docker, script or package-manager consumer.
```

The file was not regenerated. This is a package-manager hygiene cleanup, not a
Shiki dependency-graph edit. The npm lock remains the authority.

## 6. highlight.js ownership audit

Final search command:

```bash
rg -n -i \
  "highlight\.js|hljs|\.hljs|github\.css|hljs-dark" \
  . --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**'
```

Remaining hits are classified as follows:

| Category | Owner / paths | Result |
| --- | --- | --- |
| Nuvyn normal runtime | `src/lib/markdown.ts`, `src/lib/shiki.ts`, `src/main.ts` | 0 active highlight.js hits |
| Nuvyn application CSS | `src/**/*.css` | 0 `.hljs`/`hljs-*` hits; `src/hljs-dark.css` absent |
| Negative migration tests | `src/lib/__tests__/markdown.test.ts` | retained; prove old normal `hljs` contract is gone |
| MarkMap-owned test contract | `src/lib/__tests__/markmapSecurity.test.ts` | retained `features.hljs` and MarkMap-rendered class assertion |
| MarkMap transitive package | `package-lock.json` | retained through `markmap-lib@0.18.12` |
| Historical evidence | PRD, H0-H7 documents and archive | retained as historical/design records |
| Generated third-party bundle | `dist/assets/browser-DVDkpUfh.js` | MarkMap browser bundle only; not Nuvyn renderer code |
| Unexpected active Nuvyn-owned reference | none | 0 |

Production-only audit:

```text
rg ... src --glob '!**/__tests__/**' → no output
rg '\.hljs|hljs-' src --glob '*.css' → no output
test ! -f src/hljs-dark.css → PASS
```

## 7. Shiki singleton/runtime audit

Production source search found:

```text
src/lib/shiki.ts:5   createHighlighter import
src/lib/shiki.ts:24  one transformerStyleToClass(...) instance
```

There is one highlighter creation path, one module-level transformer and one
generated stylesheet owner:

```text
highlighter instances       → 1
transformer instances       → 1
reader generated CSS owners → 1, style#nuvyn-shiki-generated-styles
PDF generated CSS owners    → 1 per export, style#nuvyn-pdf-download-styles
```

The focused Shiki tests cover singleton single-flight, initialization retry,
grammar retry, aliases, concurrent loads, no-fence/unknown-only no-init,
transformer reuse, full CSS snapshot replacement and no-document safety.

## 8. Language matrix

The actual browser fixture `e2e/fixtures/pdf-export-shiki-code.md` contains
the PRD representative cases:

| Fence | H8 result | Evidence |
| --- | --- | --- |
| `js` | Shiki `pre.shiki` + token classes | fixture + `pdf-export-shiki.spec.ts` |
| `ts` | Shiki `pre.shiki` + token classes | fixture + PDF clone assertions |
| `java` | Shiki `pre.shiki` + token classes | fixture + dark-reader Kitchen Sink export |
| `sql` | Shiki `pre.shiki` + token classes | fixture + actual Shiki language chunk |
| `python` | Shiki `pre.shiki` + token classes | fixture + H2/H3/H4 runtime tests |
| unknown | `pre.shiki.nuvyn-shiki-plain`, escaped/readable | fixture + theme/PDF assertions |

H2 resolver tests cover the official registry and aliases for `js`,
`javascript`, `ts`, `typescript`, `tsx`, `jsx`, `vue`, `html`, `css`, `scss`,
`json`, `yaml`, `yml`, `md`, `markdown`, `java`, `python`, `py`, `sql`, `bash`,
`shell`, `sh`, `powershell`, `c`, `cpp`, `csharp`, `go`, `rust`, `php`,
`kotlin`, `docker`, `dockerfile`, `xml` and `diff`. Alias canonicalization is
single-flight: `js/javascript`, `ts/typescript`, `py/python`, `sh/shellscript`
and `yml/yaml` do not duplicate grammar loads.

## 9. Lazy-loading evidence

The clean H8 build transformed `3930` modules. The main entry
`dist/assets/index-Dnx_YGkk.js` is `231.72 kB / 77.96 kB gzip` and contains no
`scopeName` grammar payload. The build emitted `243` JavaScript assets with
grammar-like `scopeName` data as separate capability chunks; the bundled
registry exposes `346` languages and `65` themes without executing them all at
startup.

Runtime/unit evidence proves:

```text
no eligible supported fence → no Shiki runtime initialization
unknown-only document       → no runtime/loadLanguage
one JS fence                → JavaScript grammar prepared
JavaScript fence            → Java remains unloaded until requested
aliases/repeated JS         → one canonical grammar load
```

Representative lazy chunks from the actual H8 build:

| Asset | Raw | Gzip | Role |
| --- | ---: | ---: | --- |
| `browser-DUg2Jr4t.js` | 206.32 kB | 77.37 kB | Shiki runtime/core |
| `wasm-BnjxR4X6.js` | 622.32 kB | 232.09 kB | Oniguruma runtime |
| `javascript-Cb010CKM.js` | 174.88 kB | 16.68 kB | JavaScript grammar |
| `typescript-C17ZkDe8.js` | 181.13 kB | 16.28 kB | TypeScript grammar |
| `java-D4RbCvBe.js` | 27.27 kB | 4.30 kB | Java grammar |
| `python-gzcpVVnB.js` | 69.94 kB | 9.09 kB | Python grammar |
| `sql-DGnQv6iD.js` | 23.48 kB | 7.50 kB | SQL grammar |
| `github-light-EUqPIrTm.js` | 11.18 kB | 2.51 kB | GitHub light theme |
| `github-dark-C-LZuMrd.js` | 11.40 kB | 2.55 kB | GitHub dark theme |

The only non-MarkMap `hljs` hit in source/build inspection is none; the only
emitted `hljs` hit is the expected MarkMap browser bundle. Therefore:

```text
initial bundle absorbed all Shiki languages → NO
grammars remain lazy chunks               → YES
GitHub themes remain split/lazy            → YES
one Shiki runtime/highlighter architecture → YES
```

## 10. Security matrix

The final source contract remains:

```ts
FORBID_ATTR: ['style']
```

The focused unit suite and `e2e/markdown-shiki-security.spec.ts` cover a known
Shiki fence together with author `<style>`, raw `style`, `onclick`, `onerror`,
`javascript:` URI, `<script>` and CSS-looking source sentinels. The observed
contract is:

```text
article Shiki classes survive                 → PASS
article style attributes                      → 0
author style/event attributes                 → blocked
javascript URI                                → blocked
script/style injection                        → blocked
code source remains escaped text              → PASS
source appears in generated CSS               → NO
generated stylesheet owners outside article   → 1 trusted head owner
```

No sanitizer option, hook, allowed attribute, URI policy or `FORBID_TAGS` was
changed in H8.

## 11. Reader theme matrix

`e2e/markdown-shiki-theme.spec.ts` passed and covers the six required selector
states:

| `data-theme` | OS | Expected/observed reader palette | Result |
| --- | --- | --- | --- |
| `light` | light | light | PASS |
| `light` | dark | light | PASS |
| `dark` | light | dark | PASS |
| `dark` | dark | dark | PASS |
| absent | light | light | PASS |
| absent | dark | dark | PASS |

The same browser test proves CSS-only switching:

```text
article.innerHTML unchanged       → PASS
pre/token DOM identity unchanged  → PASS
token classes unchanged           → PASS
generated owner identity/text     → unchanged
computed token/background colors  → changed as expected
render/tokenization on switch     → none
```

Plain `nuvyn-shiki-plain` fallback readability is asserted in both light and
dark reader paths.

## 12. PDF printable-light matrix

`e2e/pdf-export-shiki.spec.ts` passed the five-case matrix:

| Reader/environment | PDF palette | Result |
| --- | --- | --- |
| explicit light + OS light | light | PASS |
| explicit light + OS dark | light | PASS |
| explicit dark + OS light | light | PASS |
| explicit dark + OS dark | light | PASS |
| no attribute + OS dark | light | PASS |

The clone assertions inspect actual computed nested token colors, not only the
`pre` background:

```text
token computed color == its --shiki-light variable → PASS
token computed color != its --shiki-dark variable  → PASS
at least two light token colors remain distinct    → PASS
plain fallback is readable on light surface        → PASS
```

The additional PDF export, layout, pagination, long-document, compatibility,
CORS and stress lanes passed. Long lines wrap without horizontal clipping;
short blocks retain keep-together behavior; oversized code becomes splittable;
100-page, code-heavy, Mermaid, MarkMap, math and image exports remain usable.
`render-theme="light"` still belongs to widget mount/readiness behavior and no
global `data-theme` mutation was introduced.

## 13. MarkMap and Mermaid regression

| Contract | Evidence | Result |
| --- | --- | --- |
| MarkMap placeholder/mount/security | focused unit/component suite | PASS |
| MarkMap math retransform | `e2e/markmap-math.spec.ts` | PASS |
| MarkMap PDF staticization/stress | PDF export + extreme MarkMap lane | PASS |
| Mermaid placeholder/component | Markdown and Mermaid component tests | PASS |
| Mermaid PDF staticization/stress | Kitchen Sink and extreme Mermaid lane | PASS |
| Exact special fences bypass Shiki | Markdown tests and runtime calls | PASS |

No MarkMap/Mermaid source or lifecycle was changed in H8. MarkMap's transitive
highlight.js remains present by design.

## 14. Markdown compatibility and resolver isolation

The extended client run covered all `src` tests relevant to the final browser
application:

```text
./node_modules/.bin/vitest run src
→ 143 files passed; 1847 tests passed
```

The complete unit run additionally passed all server/client unit files. The
Markdown migration surface remains covered for standard Markdown, task lists,
heading anchors, footnotes, definition lists, mark, WikiLinks, links, callouts,
KaTeX/math, emoji, tables, raw HTML sanitization, Mermaid, MarkMap, PDF helpers
and concurrent resolver isolation.

H2's resolver contract remains:

```text
isolated discovery env caller resolver calls → 0
fresh real render env                       → expected calls only
concurrent resolver A/B                     → isolated
```

## 15. Full test results

| Command/suite | Result |
| --- | --- |
| H7 focused Shiki/Markdown/MarkMap/PDF set | PASS — 10 files, 162 tests |
| Extended client suite `vitest run src` | PASS — 143 files, 1847 tests |
| Required + additional Chromium regression | PASS — 25 tests |
| `npm run typecheck` | PASS |
| `npm run test:unit` | PASS — 211 files, 3119 passed, 2 skipped |
| `npm run test:history-integration` | PASS — 5 files, 172 tests |
| `npm run test:recovery-integration` | PASS — 5 files, 193 tests |
| `npm test` | PASS — unit + history + recovery command chain |
| `npm run build` | PASS — 3930 modules transformed |
| `npm ci` | PASS — 477 packages added; canonical lock reproducible |
| Docker build | NOT RUN — Docker CLI exists but daemon socket was unavailable; not a repository-required H8 gate |

The `npm run test:unit` result is a real PASS from the approved local
socket/IPC execution path, not a reclassification of the earlier H0-H7
environment failures. Vitest printed non-failing jsdom `scrollTo()` and CSS
parse messages; they did not affect exit status.

## 16. H0 → H8 bundle comparison

H0 values below are historical pre-Shiki Vite values and are not regenerated.
H8 values are from the clean post-`npm ci` build. Comparisons are logical
surfaces, not hashed filenames.

| Surface | H0 gzip | H8 gzip | Delta / interpretation |
| --- | ---: | ---: | --- |
| Main entry | 77.95 kB | 77.96 kB | +0.01 kB; no meaningful initial-entry growth |
| VaultView route | 484.60 kB | 533.88 kB | +49.28 kB; official Shiki registry/runtime connected to route, not main |
| EditorPane | 932.79 kB | 932.79 kB | unchanged |
| Legacy highlight CSS combined | 1.16 kB | 0 | removed: H0 github 0.44 + hljs-dark 0.72 |
| Static application CSS | not separately recorded | 27.06 kB | H8 `index-B37GQG0h.css`, includes `src/shiki.css`; not a like-for-like H0 asset |
| Shiki runtime/core | 0 | 77.37 kB | async `browser-DUg2Jr4t.js` |
| Oniguruma WASM | 0 | 232.09 kB | async `wasm-BnjxR4X6.js` |
| JavaScript grammar | 0 | 16.68 kB | lazy chunk |
| TypeScript grammar | 0 | 16.28 kB | lazy chunk |
| Java grammar | 0 | 4.30 kB | lazy chunk |
| Python grammar | 0 | 9.09 kB | lazy chunk |
| SQL grammar | 0 | 7.50 kB | lazy chunk |
| GitHub light theme | 0 | 2.51 kB | lazy `github-light-EUqPIrTm.js` |
| GitHub dark theme | 0 | 2.55 kB | lazy `github-dark-C-LZuMrd.js` |
| MarkMap/browser | 128.78 kB | 128.78 kB | unchanged third-party bundle; transitive hljs ownership remains |

H8 current raw/gzip values include main `231.72/77.96 kB`, VaultView
`1,867.83/533.88 kB`, EditorPane `3,648.93/932.79 kB`, static CSS
`133.95/27.06 kB`, Shiki runtime `206.32/77.37 kB`, WASM
`622.32/232.09 kB`, JavaScript `174.88/16.68 kB`, TypeScript
`181.13/16.28 kB`, Java `27.27/4.30 kB`, Python `69.94/9.09 kB`, SQL
`23.48/7.50 kB`, GitHub light `11.18/2.51 kB` and GitHub dark
`11.40/2.55 kB`. The build emitted `473` files total.

## 17. Build warnings and residual risks

The clean build retained these known warning categories:

```text
Rolldown INVALID_ANNOTATION in @vueuse/core/dist/index.js
large chunk warning for existing/editor/runtime chunks
```

No new Shiki-specific warning appeared. `npm ci` also reported existing
deprecated transitive packages (`@types/svg-pan-zoom`, `whatwg-encoding`,
`prebuild-install`) and the existing audit summary of `13 vulnerabilities`
(`1 low`, `4 moderate`, `8 high`). H8 did not run `npm audit fix` or introduce
unrelated dependency churn; these are not Shiki migration regressions.

The Docker CLI was present (`29.4.2`), but the daemon socket
`/Users/txx/.docker/run/docker.sock` was unavailable. Docker was therefore
recorded as `NOT RUN`, not falsely reported as a pass. CI's Dockerfile remains
an npm/Node 22 workflow and is covered by the canonical lock/build evidence;
Docker availability is not a PRD Definition-of-Done item.

## 18. Release blockers

```text
Shiki regression        → none
security regression     → none
theme regression        → none
PDF regression          → none
MarkMap/Mermaid         → none
dependency inconsistency→ none after npm-only lock decision
bundle eager-catalog bug→ none
new build warning       → none
```

The only deliberate residual ownership is MarkMap's transitive
`highlight.js@11.11.1` and its bundled `features.hljs` contract. This is
expected third-party ownership and is not a Nuvyn normal Markdown renderer.

## 19. H0-H8 exit criteria

- [x] H0-H7 evidence is internally consistent and H8 result is recorded.
- [x] H7 completion SHA is exact and separately recorded.
- [x] Implementation Plan current H5 wording is updated to H7/H8 release state.
- [x] Direct highlight.js dependency and package-lock root edge are absent.
- [x] MarkMap transitive highlight.js is classified and preserved.
- [x] npm-only package-manager policy is explicit; `pnpm-lock.yaml` is removed for the documented reason.
- [x] No Nuvyn highlight.js runtime import or application `.hljs` CSS remains.
- [x] Shiki 4.x, one highlighter, one transformer and one generated CSS owner are proven.
- [x] Lazy language loading, aliases, unknown-only/no-fence no-init and representative language matrix are proven.
- [x] Security, reader theme, CSS-only switching and printable-light PDF token matrix are proven.
- [x] MarkMap, Mermaid, resolver isolation and Markdown compatibility regressions pass.
- [x] Focused client, extended client, Chromium, unit, integration, typecheck and build gates pass.
- [x] H0 → H8 bundle comparison and warning classification are recorded.
- [x] No production feature or H9 phase was started.

## 20. Final release verdict

```text
SHIKI-H0: COMPLETE
SHIKI-H1: COMPLETE
SHIKI-H2: COMPLETE
SHIKI-H3: COMPLETE
SHIKI-H4: COMPLETE
SHIKI-H5: COMPLETE
SHIKI-H6: COMPLETE
SHIKI-H7: COMPLETE
SHIKI-H8: COMPLETE

Nuvyn Markdown syntax engine:
SHIKI 4.4.3

Security:
CLOSED

Reader themes:
COMPLETE

PDF compatibility:
COMPLETE

Nuvyn highlight.js cleanup:
COMPLETE

Release gate:
PASS

SHIKI MIGRATION:
COMPLETE
```

There is no next syntax-highlighting phase. H8 stops after this release-gate
commit.
