# Nuvyn Shiki H7 — highlight.js Cleanup

本记录是 SHIKI-H7 的实现与验证证据。H7 只删除 Nuvyn-owned 的旧
highlight.js implementation surface；不重写 MarkMap 内部 contract，不改变
Shiki runtime、reader theme、PDF、DOMPurify 或正常 Markdown 行为。H8 的全量
release gate 尚未开始。

## 1. Phase metadata

| Item | Evidence |
| --- | --- |
| Phase | `SHIKI-H7 — Cleanup & highlight.js Removal` |
| H7 base / H6 completion | `6caa4f013e1887e2d3a6cb63450c1a9e33a0c9b2` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| H6 completion commit | `6caa4f013e1887e2d3a6cb63450c1a9e33a0c9b2` |
| H7 implementation commit | `d584abf2c64b8b46767cba72fbfc22f5b6606798` |
| Runtime | Node `v24.15.0`, npm `11.12.1`; Docker baseline remains `node:22-bookworm-slim` |
| Package-manager authority | npm; `pnpm-lock.yaml` is tracked but was not regenerated in H7 |
| Status | `SHIKI-H7 — COMPLETE`; H8 not started |
| Scope | Direct dependency, Nuvyn legacy CSS, stale current prompt wording, ownership audit and regression evidence |

The historical implementation baseline remains unchanged. H7 starts from the H6
commit above; it does not rewrite the later PDF/read-mode history.

## 2. Pre-cleanup ownership inventory

The working tree was clean at H7 start and `HEAD` was
`6caa4f013e1887e2d3a6cb63450c1a9e33a0c9b2`. Before cleanup, the required search
and dependency commands were run:

```bash
rg -n -i \
  "highlight\.js|hljs|\.hljs|github\.css|hljs-dark" \
  . --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**'
npm ls highlight.js
npm explain highlight.js
```

The pre-cleanup result was classified by ownership rather than deleted
mechanically:

| Hit | Owner | Active? | H7 action |
| --- | --- | --- | --- |
| `package.json:40` direct `highlight.js: ^11.10.0` | Nuvyn | Yes; root dependency | REMOVE with npm |
| `package-lock.json` root dependency entry | Nuvyn | Yes; root edge | REMOVE through npm |
| `package-lock.json` `node_modules/highlight.js` and `markmap-lib` edge | MarkMap transitive | Yes; required by `markmap-lib@0.18.12` | KEEP |
| `pnpm-lock.yaml` importer and package records | Noncanonical tracked lock; importer still reflects the old root specifier, package graph also contains MarkMap edge | Not used by the npm workflow | KEEP unchanged and document |
| `src/hljs-dark.css:1-98` | Nuvyn | Obsolete after H5 Shiki CSS | DELETE |
| `src/lib/__tests__/markdown.test.ts:74,567,612,752,838` | Nuvyn migration tests | Negative assertions proving `hljs` is absent from normal output | KEEP |
| `src/lib/__tests__/markmapSecurity.test.ts:86-88` | MarkMap transformer | Yes; `features.hljs` and rendered MarkMap HTML contract | KEEP |
| `server/ai/prompt.md:64` | Nuvyn current prompt wording | Stale; described normal fences as highlight.js | UPDATE to Shiki |
| H0-H6 evidence, PRD and archive documents | Historical migration evidence | Yes; historical facts and requirements | KEEP |

Before removal, `npm ls highlight.js` showed a root copy deduped with MarkMap:

```text
nuvyn@0.0.0 /Users/txx/nuvyn
├── highlight.js@11.11.1
└─┬ markmap-lib@0.18.12
  └── highlight.js@11.11.1 deduped
```

The pre-cleanup `npm explain highlight.js` output showed both edges:

```text
highlight.js@11.11.1
node_modules/highlight.js
  highlight.js@"^11.10.0" from the root project
  highlight.js@"^11.8.0" from markmap-lib@0.18.12
  node_modules/markmap-lib
    markmap-lib@"^0.18.12" from the root project
```

Repeated `.hljs-*` lines in `src/hljs-dark.css` were one Nuvyn-owned CSS file,
not separate ownerships. The H0-H6 document hits were retained as historical
records and are not current runtime consumers.

## 3. Direct dependency removal

The canonical command was:

```bash
npm remove highlight.js
```

It changed only the root dependency declarations in `package.json` and
`package-lock.json`:

```diff
- "highlight.js": "^11.10.0",
```

No package version refresh or manual lockfile surgery was performed. The Shiki
dependencies remain unchanged.

## 4. npm lock graph after cleanup

The post-cleanup package check is:

```text
NO_DIRECT_HIGHLIGHT_JS
```

`npm ls highlight.js` now reports only the protected MarkMap path:

```text
nuvyn@0.0.0 /Users/txx/nuvyn
└─┬ markmap-lib@0.18.12
  └── highlight.js@11.11.1
```

`npm explain highlight.js` now reports:

```text
highlight.js@11.11.1
node_modules/highlight.js
  highlight.js@"^11.8.0" from markmap-lib@0.18.12
  node_modules/markmap-lib
    markmap-lib@"^0.18.12" from the root project
```

Therefore:

| Dependency fact | Result |
| --- | --- |
| `package.json` direct Nuvyn edge | REMOVED |
| `package-lock.json` root edge | REMOVED |
| `package-lock.json` package record | PRESENT; required by MarkMap |
| `markmap-lib@0.18.12 → highlight.js@^11.8.0` | PRESENT / EXPECTED / THIRD-PARTY TRANSITIVE |
| Nuvyn normal Markdown renderer consumes the remaining package | NO |

The tracked `pnpm-lock.yaml` was intentionally not regenerated because npm is
the repository workflow for this migration and H7 explicitly forbids changing
the pnpm lock. Its old importer hit is classified as a noncanonical lockfile
hygiene discrepancy, not as an active Nuvyn runtime edge. The authoritative
root manifest and npm lock graph are clean.

## 5. Nuvyn-owned CSS removal

`src/hljs-dark.css` was deleted. It was the Nuvyn-owned GitHub-dark
highlight.js stylesheet, including OS-dark and forced-dark `.hljs-*` selectors.

Post-cleanup checks:

```text
test ! -f src/hljs-dark.css                    PASS
rg "hljs-dark\.css" src                       no results
rg "\.hljs|hljs-" src --glob '*.css'          no results
rg "highlight\.js/styles|github\.css" src    no results
```

No `src/highlight.css`, `src/hljs.css` or compatibility replacement was added.
Reader syntax styling remains owned by `src/shiki.css` and the generated Shiki
stylesheet owner.

## 6. Production source audit

The post-cleanup source search was:

```bash
rg -n -i "highlight\.js|hljs|\.hljs|github\.css|hljs-dark" \
  src server shared e2e --glob '!node_modules/**' --glob '!dist/**'
```

The only remaining hits are intentional test contracts:

```text
src/lib/__tests__/markdown.test.ts
  negative assertions that normal output contains no class="hljs" / pre.hljs

src/lib/__tests__/markmapSecurity.test.ts
  MarkMap features.hljs and MarkMap-rendered hljs class assertion
```

There are no active Nuvyn production imports of `highlight.js`,
`highlight.js/styles/github.css`, `src/hljs-dark.css`, or `hljs.highlight()`.
The current AI prompt in `server/ai/prompt.md` now describes normal language
fences as rendered by Shiki.

`src/lib/markdown.ts`, `src/lib/shiki.ts`, `src/shiki.css`, `src/main.ts`, the
sanitizer, theme composables and PDF implementation were not changed by H7.

## 7. Current test-contract audit

Normal Markdown tests already use the H3-H6 Shiki contract:

```text
pre.shiki
nuvyn-shiki-*
nuvyn-shiki-plain
```

The five remaining `hljs` assertions in `markdown.test.ts` are all negative
assertions. They explicitly prove that the old normal-renderer contract is
gone; they do not require highlight.js and were retained as useful migration
guards. No stale positive assertion for normal `class="hljs"`,
`pre.hljs` or `hljs-keyword` remains in the Nuvyn Markdown tests.

## 8. MarkMap transitive ownership

H7 did not patch, disable or reconfigure MarkMap. The protected boundary remains:

```text
markmap-lib@0.18.12
  └── highlight.js@11.11.1
      └── MarkMap Transformer features.hljs
```

The following are MarkMap-owned and intentionally remain:

- `src/lib/__tests__/markmapSecurity.test.ts` `features.hljs` and rendered class;
- the transitive npm lock/package record;
- the corresponding third-party code bundled in the MarkMap browser chunk.

No MarkMap dependency version changed, and no MarkMap internal was rewritten.

## 9. Historical-document handling

H0-H6 evidence was not rewritten to pretend that earlier phases started after
H7. Statements such as “H0 used highlight.js”, “H3 retained the dependency for
rollback”, and “H6 handed off to H7” remain historically accurate.

The current implementation plan and `docs/README.md` now point to H7 and state
that H8 is next. H6 received only the requested exact completion SHA and the
wording correction from “H9 huge code lane” / “H9 extreme ... lanes” to the
existing stress/huge-code lane names. The PRD remains unchanged.

## 10. Build artifact audit

After removing the direct dependency, a clean build was run:

```bash
rm -rf dist
npm run build
```

Result:

```text
PASS — 3930 modules transformed
473 emitted files
```

The build retained the pre-existing Rolldown `INVALID_ANNOTATION` warnings for
`@vueuse/core` and existing large-chunk warnings. No Nuvyn-owned legacy CSS
asset was emitted:

```text
github*.css     NONE
hljs-dark*.css  NONE
```

The post-build search found one minified JS asset containing `hljs`:
`dist/assets/browser-DVDkpUfh.js`. Its content is the MarkMap bundled
`features.hljs`/CDN transformer code, not a Nuvyn Markdown renderer or copied
Nuvyn stylesheet. This is the expected third-party artifact and is not a H7
failure. Shiki language/theme assets remain split, including JavaScript,
TypeScript, Java, Python, SQL and GitHub theme chunks.

Representative current assets (raw / gzip, from Vite output) are:

| Asset | Raw | Gzip | Ownership |
| --- | ---: | ---: | --- |
| `index-Dnx_YGkk.js` | 231.72 kB | 77.96 kB | main entry |
| `VaultView-brT1zakg.js` | 1,867.83 kB | 533.88 kB | Vault route |
| `browser-DUg2Jr4t.js` | 206.32 kB | 77.37 kB | Shiki runtime/core async chunk |
| `browser-DVDkpUfh.js` | 391.49 kB | 128.78 kB | MarkMap browser bundle; contains transitive hljs |
| `wasm-BnjxR4X6.js` | 622.32 kB | 232.09 kB | Shiki/Oniguruma runtime chunk |
| `javascript-Cb010CKM.js` | 174.88 kB | 16.68 kB | lazy Shiki grammar |
| `typescript-C17ZkDe8.js` | 181.13 kB | 16.28 kB | lazy Shiki grammar |
| `java-D4RbCvBe.js` | 27.27 kB | 4.30 kB | lazy Shiki grammar |
| `python-gzcpVVnB.js` | 69.94 kB | 9.09 kB | lazy Shiki grammar |
| `sql-DGnQv6iD.js` | 23.48 kB | 7.50 kB | lazy Shiki grammar |
| `github-light-EUqPIrTm.js` | 11.18 kB | 2.51 kB | lazy Shiki theme |
| `github-dark-C-LZuMrd.js` | 11.39 kB | 2.55 kB | lazy Shiki theme |

The H7 delta does not change Shiki runtime/language/theme chunk architecture.
The remaining MarkMap transitive bundle is not a reason to manually edit the
lockfile or fork MarkMap.

## 11. Markdown / Shiki regressions

Focused Vitest command:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/shiki.test.ts \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/markmapSecurity.test.ts \
  src/lib/__tests__/pdfExport.test.ts \
  src/lib/__tests__/pdf-readiness.test.ts \
  src/components/__tests__/MarkMap.test.ts \
  src/components/__tests__/MarkMapSecurity.test.ts \
  src/components/__tests__/Mermaid.test.ts \
  src/components/vault/__tests__/PdfExportSurface.test.ts \
  src/composables/vault/__tests__/useMarkdownRender.test.ts
```

Result: **PASS — 10 files, 162 tests**. No Shiki, Markdown, sanitizer,
resolver, Mermaid, MarkMap or PDF client regression was introduced.

## 12. MarkMap regressions

The focused component tests above passed, including `MarkMap.test.ts` and
`MarkMapSecurity.test.ts`. The browser MarkMap math regression also passed:

```text
e2e/markmap-math.spec.ts → PASS
```

The PDF stress lanes for extreme MarkMap and Mermaid passed as part of the
17-test Chromium run. This proves the remaining MarkMap-owned highlight.js
edge can stay in place without restoring a Nuvyn direct dependency.

## 13. PDF / theme / security regressions

The required Chromium regression command ran with local web-server permission
after the sandbox-only `listen EPERM` attempt was recorded. Result:

```text
17 passed
```

Covered files include:

```text
e2e/markdown-shiki-security.spec.ts
e2e/markdown-shiki-theme.spec.ts
e2e/markdown-visual.spec.ts
e2e/markmap-math.spec.ts
e2e/pdf-export-shiki.spec.ts
e2e/pdf-export.spec.ts
e2e/pdf-export-layout.spec.ts
e2e/pdf-export-pagination.spec.ts
e2e/pdf-export-stress.spec.ts
```

The H6 computed-color matrix, PDF export cleanup, printable wrapping,
pagination, 100-page, huge-code, Mermaid, MarkMap, math and image lanes all
remain green. H4 security and H5 theme behavior remain green.

## 14. Full repository search classification

The final search used the same expression as the pre-cleanup inventory, while
excluding `node_modules`, `dist` and `.git`. Every remaining result belongs to
one of these intentional categories:

| Category | Remaining paths / hits | Classification |
| --- | --- | --- |
| D. MarkMap-owned source/test | `src/lib/__tests__/markmapSecurity.test.ts` | Protected `features.hljs` and rendered MarkMap contract |
| C. Negative migration tests | `src/lib/__tests__/markdown.test.ts` | Prove normal Shiki output has no old `hljs` contract |
| E. npm transitive dependency | `package-lock.json` | `markmap-lib → highlight.js` only; no root edge |
| E. Noncanonical tracked lock | `pnpm-lock.yaml` | Not regenerated per H7 instruction; separately documented |
| F. Historical migration evidence | PRD, H0-H6 evidence and implementation plan history | Must remain accurate; not active runtime |
| F. Historical archive | `docs/archive/plans/2026-06-07-sqlite-ai-history.md` | Historical dependency example |
| G. Generated artifact | `dist/assets/browser-DVDkpUfh.js` only | MarkMap third-party bundle; excluded from source ownership audit |
| Unexpected Nuvyn-owned active runtime/CSS | None | **0** |

The goal was not a mechanically empty `rg` result. The goal was zero
unexplained Nuvyn-owned active references while preserving MarkMap and history.

## 15. Validation results

| Command / check | Result |
| --- | --- |
| `npm remove highlight.js` | PASS; root manifest and npm lock edge removed |
| `npm ls highlight.js` / `npm explain highlight.js` | PASS; MarkMap transitive only |
| focused Vitest | PASS — 10 files / 162 tests |
| Chromium Markdown/MarkMap/PDF regression | PASS — 17 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 3930 modules transformed; existing warnings only |
| `npm run test:unit` | FAIL honestly recorded: 3 files / 21 tests; 208 files / 3098 tests passed, 2 skipped |
| `git diff --check` | PASS |

The full-unit failures are unchanged environment limitations:

```text
19 server/__tests__/openai-http.test.ts tests → listen EPERM 127.0.0.1
Round-15 child-process test → tsx IPC pipe listen EPERM
Round-16 child-process test → tsx IPC pipe listen EPERM
```

No new Shiki, Markdown, MarkMap, PDF, theme, security or client failure
appeared. The first unprivileged E2E attempt had the same local-server
`listen EPERM`; the required Chromium command passed when run with the
approved local-web-server capability.

## 16. H7 exit criteria

- [x] Pre-cleanup ownership inventory exists and includes npm graph evidence.
- [x] Every remaining repository search hit is classified.
- [x] Root `package.json` no longer declares `highlight.js`.
- [x] Root npm package-lock dependency edge is removed by npm.
- [x] MarkMap transitive `highlight.js` ownership is preserved and explained.
- [x] `src/hljs-dark.css` is deleted; no replacement compatibility sheet exists.
- [x] No Nuvyn normal runtime imports highlight.js or GitHub highlight CSS.
- [x] Nuvyn application `.hljs` CSS is absent.
- [x] Normal Markdown tests use Shiki contracts; useful negative assertions remain.
- [x] Historical H0-H6 evidence and PRD requirements remain historically accurate.
- [x] Current plan, README and active prompt reflect Shiki normal rendering and H7 cleanup.
- [x] MarkMap unit/component/browser/PDF regressions pass.
- [x] Shiki, Markdown, security, theme and PDF regressions pass.
- [x] Typecheck and production build pass.
- [x] Legacy Nuvyn CSS assets are absent from the build.
- [x] No unrelated dependency version churn occurred.
- [x] H6 completion SHA and H6 stress-lane wording are corrected.
- [x] H8 has not started.

The full unit command remains a documented pre-existing environment limitation,
not a Shiki or H7 regression; it is not relabeled as green.

## 17. H8 handoff

H7 is complete. The next phase is:

```text
SHIKI-H8 — Full Regression, Bundle Audit & Release Gate
```

H8 must make the final PRD Definition-of-Done decision, capture the complete
bundle comparison against the historical H0/H6 evidence, and close the release
checklist. H7 does not claim that the migration is released merely because the
Nuvyn-owned highlight.js surface is gone.

Current state:

```text
SHIKI-H0: COMPLETE
SHIKI-H1: COMPLETE
SHIKI-H2: COMPLETE
SHIKI-H3: COMPLETE
SHIKI-H4: COMPLETE
SHIKI-H5: COMPLETE
SHIKI-H6: COMPLETE
SHIKI-H7: COMPLETE

Nuvyn normal renderer: SHIKI
Nuvyn direct highlight.js: REMOVED
Nuvyn legacy hljs CSS: REMOVED
MarkMap transitive highlight.js: PRESERVED / CLASSIFIED
Reader theme: PRESERVED
PDF: PRESERVED
Security: PRESERVED
H8: NOT STARTED
Next: SHIKI-H8 — Full Regression, Bundle Audit & Release Gate
```
