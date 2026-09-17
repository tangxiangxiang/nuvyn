# Nuvyn Shiki H1 — Dependency & Runtime Foundation

> H1 establishes the Shiki runtime foundation only. Normal Markdown fences still use highlight.js; H2 language discovery and H3 renderer cutover have not started.

## 1. Phase metadata

| Item | Evidence |
| --- | --- |
| Phase status | `SHIKI-H1 — COMPLETE` |
| Authoritative PRD | [Shiki Syntax Highlighting Migration PRD](syntax-highlighting-shiki-migration-prd.md) |
| Execution plan | [Shiki Syntax Highlighting Migration Implementation Plan](syntax-highlighting-shiki-migration-implementation-plan.md) |
| H0 evidence | [Shiki H0 Baseline & Contract Audit](syntax-highlighting-shiki-h0-audit.md) |
| H1 start commit | `50fba62471c6a16eb36224227ded2c957d2e65a2` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| Local evidence runtime | Node `v24.15.0`, npm `11.12.1` |
| Docker runtime baseline | `node:22-bookworm-slim` in `Dockerfile` |
| H1 scope | Dependency and runtime foundation only; no Markdown renderer, CSS, PDF, sanitizer, theme, Mermaid or MarkMap behavior change |
| H1 completion commit | `7c020709eaeafb8dacd7db69adaa9dadfa4a4ae9` |

The H0 implementation baseline remains `2be6b2c...`. H1 starts from the later documentation-only state at `50fba624...`; this does not change the migration baseline recorded by the plan.

## 2. Dependency changes

The canonical npm installation added matching Shiki packages and left the existing renderer dependency in place:

| Package | `package.json` | Resolved version | H1 disposition |
| --- | --- | --- | --- |
| `shiki` | `^4.4.3` | `4.4.3` | New H1 runtime dependency |
| `@shikijs/transformers` | `^4.4.3` | `4.4.3` | New matching transformer dependency |
| `highlight.js` | `^11.10.0` | `11.11.1` | Still active; removal remains H7 work |

The install command was:

```bash
npm install shiki@4.4.3 @shikijs/transformers@4.4.3
```

`npm ls --depth=0` verified `shiki@4.4.3` and `@shikijs/transformers@4.4.3`. Shiki and the transformer both declare `node >=20`, so the Docker Node 22 baseline is compatible. npm reported `13 vulnerabilities (1 low, 4 moderate, 8 high)` after installation; H1 did not run `npm audit fix` or make unrelated upgrades.

Only `package.json` and `package-lock.json` changed for dependency installation. `pnpm-lock.yaml` was intentionally left untouched because CI, Docker, contributor setup and the repository docs use npm, while H0 already recorded unrelated pnpm importer drift for `better-sqlite3`.

## 3. Package-manager decision

The repository's authoritative installation path is npm:

- `.github/workflows/ci.yml` uses `actions/setup-node` with npm cache and `npm ci`;
- `Dockerfile` copies `package-lock.json` and runs `npm ci`;
- development and setup documentation instruct contributors to use npm and the committed npm lockfile.

H1 therefore used npm's normal lockfile update. No manual lockfile editing and no repair of the noncanonical pnpm drift was performed.

## 4. Runtime architecture

The focused module is:

```text
src/lib/shiki.ts
```

It owns only H1 lifecycle concerns:

- the module-level `createHighlighter` factory and cached runtime promise;
- initialization of `github-light` and `github-dark`;
- the single `transformerStyleToClass` instance;
- the generated CSS snapshot accessor;
- a narrowly scoped test seam for single-flight and retry tests.

The runtime is initialized with the equivalent of:

```ts
createHighlighter({
  themes: ['github-light', 'github-dark'],
  langs: [],
})
```

The installed Shiki API was inspected rather than assuming an older API. The runtime module does not import `src/lib/markdown.ts`, `main.ts`, `style.css`, `hljs-dark.css`, PDF code or Vue components. It is intentionally not imported by a production consumer during H1, so the build can tree-shake the foundation until H2/H3 integration.

## 5. Singleton contract

`getShikiRuntime()` keeps one module-level `Promise<Highlighter>`:

```text
first caller       → create one highlighter promise
concurrent callers → receive that same promise
later callers      → receive the same resolved runtime
```

The implementation never creates a runtime per render, component, fence or language. The focused test holds initialization pending and proves that three concurrent calls invoke the factory once and resolve to the same object.

## 6. Initialization failure and retry contract

An asynchronous initialization rejection clears the cached promise only if it is still the active promise. A synchronous factory throw is returned as a rejected promise without caching it. Therefore:

```text
first getShikiRuntime()  → rejects
next getShikiRuntime()   → creates a fresh runtime
```

The focused test injects a factory that rejects once and succeeds on the second call; the factory is invoked twice and the successful runtime is then cached. The test-only reset also disposes a resolved runtime and clears the transformer registry between test cases.

## 7. Theme initialization

The real installed runtime reports:

```text
getLoadedThemes()    → ['github-light', 'github-dark']
getLoadedLanguages() → []
```

This proves the H1 runtime loads both required themes without eagerly loading the normal programming-language catalog. It does not claim that H2's future language loader exists.

## 8. Transformer contract

`src/lib/shiki.ts` creates exactly one module-level transformer:

```ts
transformerStyleToClass({
  classPrefix: 'nuvyn-shiki-',
})
```

The narrow runtime API is:

```text
getShikiRuntime()
getShikiStyleTransformer()
getGeneratedShikiCss()
```

`getGeneratedShikiCss()` returns `transformer.getCSS()` and does not create or update a DOM stylesheet. The compatibility test uses a separate test-only JavaScript highlighter with the shared transformer. It verifies that the installed pair produces `nuvyn-shiki-*` classes and corresponding `--shiki-light`/`--shiki-dark` CSS. That probe is not production language-loading architecture.

## 9. H1 language-loading boundary

No H2 language system was added. There is no `loadLanguage`, `loadedLanguageSet`, `inFlightLanguageLoads`, alias normalizer, fence discovery, unknown-language fallback or MarkdownIt preflight in the H1 implementation. `src/lib/markdown.ts` was not modified.

The H0 blocker remains open:

```text
md.parse(markdown, env) + md.render(markdown, env)
can double-call the wiki resolver.
```

Before H2 implements discovery, it must choose a strategy that does not duplicate resolver side effects. H1 did not parse Markdown twice or attempt to solve this blocker.

## 10. Unit-test evidence

New tests live in:

```text
src/lib/__tests__/shiki.test.ts
```

The focused run was:

```bash
./node_modules/.bin/vitest run src/lib/__tests__/shiki.test.ts
```

Result: `1 file passed; 6 tests passed`.

| Contract | Evidence |
| --- | --- |
| Singleton and concurrent single-flight | Three concurrent calls invoke the injected factory once and resolve to one runtime |
| Failed initialization retry | First factory call rejects; the next call creates and caches a fresh runtime |
| Themes available | Actual Shiki runtime reports both GitHub themes |
| No eager application languages | Actual H1 runtime reports an empty loaded-language list |
| Transformer singleton and CSS | Shared transformer produces `nuvyn-shiki-*` classes and dual-theme CSS in the isolated compatibility probe |
| No DOM stylesheet ownership | Runtime initialization leaves style count and any managed style ID unchanged |
| No-document safety | Runtime initialization and CSS snapshot access run with `document` unavailable |

## 11. Markdown regression evidence

The existing renderer regression run was:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/markmapSecurity.test.ts
```

Result: `2 files passed; 40 tests passed`.

The Markdown test still asserts the normal `class="hljs"` contract. MarkMap's `features.hljs` ownership remains untouched. `src/lib/markdown.ts`, `src/lib/__tests__/markdown.test.ts` and `src/lib/__tests__/markmapSecurity.test.ts` were not rewritten for Shiki.

## 12. Build and bundle evidence

The H1 production build was:

```bash
npm run build
```

Result: `PASS`, 3,721 modules transformed, with the same existing Rolldown pure-annotation warnings and >500 kB chunk warning recorded by H0.

The post-H1 build emitted the same relevant assets as the H0 baseline:

| Asset | Raw | Gzip | H1 observation |
| --- | ---: | ---: | --- |
| `github-DdKuH37F.css` | 1.06 kB | 0.44 kB | Existing highlight.js light CSS remains |
| `hljs-dark-Gf5kSmHw.css` | 4.44 kB | 0.72 kB | Existing Nuvyn dark CSS remains |
| `markdown-Cimd5fb3.js` | 3.63 kB | 1.34 kB | Unchanged Markdown/highlighter chunk |
| `index-CP3umf6P.js` | 231.72 kB | 77.95 kB | Unchanged main application chunk |
| `VaultView-vg19isgt.js` | 1,712.61 kB | 484.60 kB | Unchanged existing large chunk |
| `EditorPane-CzC7jkOt.js` | 3,648.93 kB | 932.79 kB | Unchanged existing large chunk |
| `es-BJ9eesMT.js` | 914.55 kB | 304.42 kB | Unchanged existing dependency chunk |
| `chunk-NNHCCRGN-DlpIbxXb.js` | 593.66 kB | 137.74 kB | Unchanged existing dependency chunk |
| `cytoscape.esm-h6BdjjI9.js` | 435.41 kB | 137.93 kB | Unchanged existing graph dependency |
| `browser-DVDkpUfh.js` | 391.49 kB | 128.78 kB | Unchanged existing browser dependency |

No Shiki runtime, theme or grammar asset was emitted. Because H1 intentionally has no production consumer, `src/lib/shiki.ts` is currently tree-shaken from the production bundle. This is acceptable for H1 and avoids a fake `main.ts` import. H8 must repeat the audit after H2/H3 integration and prove that the eventual language architecture remains lazy; H1 does not claim the final bundle shape.

## 13. Known baseline failures and warnings

The required full unit command was run:

```bash
npm run test:unit
```

Result: `FAIL` — `3 files failed, 208 passed`; `21 tests failed, 3,060 passed, 2 skipped`.

All 21 failures match the H0 environment limitation and are server-only:

- 19 `server/__tests__/openai-http.test.ts` cases fail with `listen EPERM: operation not permitted 127.0.0.1`;
- one Round-15 crash-recovery case fails because the `tsx` child cannot listen on its temporary IPC pipe;
- one Round-16 crash-recovery case fails with the same `tsx` IPC `listen EPERM` signature.

No Shiki, Markdown, client, MarkMap or sanitizer failure appeared in the full run. The result is recorded as `FAIL`, not converted to a pass. The non-failing `Window's scrollTo()` messages remain jsdom warnings. These failures are the same pre-existing environment category documented by H0 and require CI/approved local process permissions for a clean full-suite result.

## 14. Production behavior verification

H1 intentionally preserves the following:

```text
normal Markdown fence renderer → highlight.js
normal fence HTML             → class="hljs" contract
DOMPurify                     → unchanged, including FORBID_ATTR: ['style']
MarkMap                       → unchanged and still owns its internal features.hljs
Mermaid                       → unchanged
theme behavior                → unchanged
PDF behavior                  → unchanged
generated DOM stylesheet      → none
src/shiki.css                 → not created
```

The source audit confirms there is no production `loadLanguage` orchestration, no Shiki import in `main.ts`, no change to `src/lib/markdown.ts`, no change to `src/lib/pdfExport.ts`, and no change to `src/hljs-dark.css` or `src/style.css`.

## 15. H1 exit criteria

- [x] Matching Shiki 4.4.3 and transformer 4.4.3 are installed and resolved.
- [x] npm/package-lock is documented as canonical; pnpm lock drift is untouched.
- [x] Docker Node 22 compatibility is confirmed by the packages' `node >=20` engines.
- [x] Focused `src/lib/shiki.ts` exists.
- [x] Highlighter singleton and concurrent single-flight behavior are tested.
- [x] Initialization failure clears the rejected cache and permits retry.
- [x] Both GitHub themes are actually loaded.
- [x] Runtime starts with no eager programming-language catalog.
- [x] One stable `transformerStyleToClass` instance exists with the `nuvyn-shiki-` prefix.
- [x] CSS snapshot access works without DOM ownership.
- [x] No production language discovery/loading system was added.
- [x] Existing Markdown renderer and highlight.js tests remain active.
- [x] DOMPurify, theme behavior, PDF, Mermaid and MarkMap were not changed.
- [x] `npm run typecheck` and `npm run build` pass.
- [x] H1 focused runtime tests pass.
- [x] Full unit-suite failures were run and separately classified as H0 environment limitations.
- [x] H0 double-parse blocker remains visible for H2.
- [x] No H2/H3 behavior slipped into H1.

H1 is complete with the documented pre-existing full-suite environment limitation. This does not close the release gate or imply that Shiki Markdown integration is complete.

## 16. H2 handoff

Next phase:

```text
SHIKI-H2 — Fence Discovery & Dynamic Language Loading
```

H2 must first resolve the discovery strategy around the H0 wiki-resolver double-call blocker. It may then introduce language normalization, registry lookup, loaded-language deduplication and in-flight loading, but it must not silently change the PRD or begin renderer cutover before H3.

Current state at handoff:

```text
SHIKI-H0: COMPLETE
SHIKI-H1: COMPLETE
SHIKI-H2: NOT STARTED
Shiki runtime foundation: READY
Markdown renderer: highlight.js
H2 resolver double-parse blocker: OPEN
```
