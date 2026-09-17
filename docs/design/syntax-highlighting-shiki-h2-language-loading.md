# Nuvyn Shiki H2 — Fence Discovery & Dynamic Language Loading

> H2 connects the Shiki runtime to the Markdown preparation path. Normal
> Markdown fences still render through highlight.js; Shiki token HTML and
> renderer cutover remain H3 work.

## 1. Phase metadata

| Item | Evidence |
| --- | --- |
| Phase status | `SHIKI-H2 — COMPLETE` |
| Authoritative PRD | [Shiki Syntax Highlighting Migration PRD](syntax-highlighting-shiki-migration-prd.md) |
| Execution plan | [Shiki Syntax Highlighting Migration Implementation Plan](syntax-highlighting-shiki-migration-implementation-plan.md) |
| H0 evidence | [Shiki H0 Baseline & Contract Audit](syntax-highlighting-shiki-h0-audit.md) |
| H1 evidence | [Shiki H1 Dependency & Runtime Foundation](syntax-highlighting-shiki-h1-runtime-foundation.md) |
| H2 start commit | `7c020709eaeafb8dacd7db69adaa9dadfa4a4ae9` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| Local evidence runtime | Node `v24.15.0`, npm `11.12.1` |
| Docker runtime baseline | `node:22-bookworm-slim` in `Dockerfile` |
| H2 scope | Fence token discovery, isolated MarkdownIt preflight, official registry resolution, lazy grammar preparation, canonical deduplication and retryable failure handling |
| H2 completion commit | `ced290e0f640507bae947aad5218fa7b4c4abe54` |

H2 does not install or change dependencies. Shiki remains `4.4.3`,
`@shikijs/transformers` remains `4.4.3`, and highlight.js remains the active
normal-fence renderer.

## 2. H2 architecture

The production path is now:

```text
render(markdown, options)
    ↓
getMd()
    ↓
md.parse(markdown, fresh isolated discovery env)
    ↓
token.type === 'fence'
    ↓
extract first token from token.info
    ↓
exact Nuvyn special-fence check
    ↓
Shiki official registry/alias lookup
    ↓
canonical language deduplication
    ↓
await shared in-flight grammar preparation
    ↓
md.render(markdown, fresh real render env)
    ↓
highlight.js callback / existing MarkMap and Mermaid placeholders
    ↓
DOMPurify
```

The implementation boundaries are:

| Responsibility | Location | H2 API/evidence |
| --- | --- | --- |
| MarkdownIt fence-token discovery | `src/lib/markdown.ts` | `discoverFenceLanguageIdentifiers()` |
| First info-token extraction | `src/lib/shiki.ts` | `extractFenceLanguageIdentifier()` |
| Special/empty/unknown/alias resolution | `src/lib/shiki.ts` | `resolveShikiLanguage()` |
| Singleton and grammar state | `src/lib/shiki.ts` | `getShikiRuntime()`, canonical sets/maps |
| Per-document preparation | `src/lib/shiki.ts` | `prepareShikiLanguages()`, `ensureShikiLanguage()` |
| Final Markdown render | `src/lib/markdown.ts` | fresh `WikiLinkEnv` passed only to `md.render()` |

No normal Markdown path calls `codeToHtml()`. No Shiki HTML is visible to the
user in H2.

## 3. Double-parse blocker resolution

H0 identified that this sequence is unsafe:

```text
md.parse(markdown, realEnv)
md.render(markdown, realEnv)
```

The wiki-link inline rule invokes the resolver during parse, so reusing the
real env would double-call caller-owned resolver side effects.

H2 uses two render-scoped env objects:

```ts
const discoveryEnv: WikiLinkEnv = {}
const tokens = md.parse(markdown, discoveryEnv)

await prepareShikiLanguages(discoveredIdentifiers)

const renderEnv: WikiLinkEnv = options.resolver
  ? { wikiResolver: options.resolver }
  : {}
const html = md.render(markdown, renderEnv)
```

The caller resolver is never present in `discoveryEnv`, and the discovery env
is never reused for final rendering.

## 4. Discovery env isolation

`src/lib/wikiLinks.ts` already falls back to its internal identity resolver
when `env.wikiResolver` is absent. That fallback is suitable for tokenization;
it does not invoke the caller's resolver and does not create shared module
state.

Each call to `discoverFenceLanguageIdentifiers()` creates a new empty env.
Each call to `render()` creates a new final env. Concurrent renders therefore
share only the Shiki language runtime state, not a mutable Markdown env or a
resolver.

The regression suite covers concurrent render A/B calls with distinct
resolvers and JavaScript fences. Each resolver is called once for its own
final render and no target from the other render appears in its HTML.

## 5. Fence-token discovery

Discovery uses the same MarkdownIt instance that performs the final render:

```ts
md.parse(markdown, discoveryEnv)
  .filter((token) => token.type === 'fence')
```

There is no unrestricted regular expression over raw Markdown. Inline code,
indented code, raw HTML strings, prose mentioning triple backticks and fence
text inside a real code block do not become language requests unless
MarkdownIt emits an actual `fence` token.

For each fence token, only `token.info` is interpreted. The helper trims it
and takes the first whitespace-delimited token:

```text
"  js title=demo  " → js
"python linenums"   → python
"" or "   "         → empty
```

Fence source is not inspected or modified. Fence metadata is not used for
registry lookup.

## 6. Language normalization

Normal language identifiers use this sequence:

```text
trim first info token
    ↓
lowercase for registry lookup only
    ↓
resolve official canonical language and loader
```

The source code and MarkdownIt token remain unchanged. Examples verified by
the focused tests include:

| Input | Result |
| --- | --- |
| `js`, `javascript` | canonical `javascript` |
| `ts`, `typescript` | canonical `typescript` |
| `py`, `python` | canonical `python` |
| `sh`, `bash`, `shell` | canonical `shellscript` |
| `yml`, `yaml` | canonical `yaml` |
| `md`, `markdown` | canonical `markdown` |
| `JS`, `PY`, `JavaScript` | same canonical results after lookup normalization |
| `js title=demo` | only `js` is resolved |

The full official registry remains available; the implementation does not
replace it with a short hand-written allowlist.

## 7. Bundled registry and aliases

`src/lib/shiki.ts` imports these Shiki 4.4.3 exports:

```ts
bundledLanguages
bundledLanguagesBase
bundledLanguagesInfo
```

`bundledLanguagesInfo` supplies canonical IDs and official aliases. The
implementation derives its lookup index from that metadata, validates the
normalized identifier against `bundledLanguages`, and uses the canonical
loader from `bundledLanguagesBase`.

This preserves valid bundled languages beyond the acceptance examples. The
focused resolver test covers `tsx`, `jsx`, `vue`, `html`, `css`, `scss`,
`json`, `java`, `sql`, `powershell`, `c`, `cpp`, `csharp`, `go`, `rust`,
`php`, `kotlin`, `docker`, `dockerfile`, `xml` and `diff`.

User input never becomes a module specifier. There is no implementation such
as `import('@shikijs/langs/' + rawIdentifier)`; only a trusted loader obtained
from Shiki's bundled registry is passed to `highlighter.loadLanguage()`.

## 8. Runtime language state

The H1 singleton in `src/lib/shiki.ts` now owns H2 state as well:

```text
highlighterPromise       → one long-lived runtime promise
loadedLanguageSet        → canonical language IDs
inFlightLanguageLoads    → canonical ID → shared preparation Promise
unsupportedLanguageSet   → deterministic normalized unknown IDs
languageStateGeneration  → protects test reset from stale completions
```

After runtime initialization and before each preparation, the state is seeded
from `runtime.getLoadedLanguages()`. Shiki may report canonical IDs and
aliases; H2 maps both back to one canonical ID. The internal set is therefore
a canonical fast path, while the highlighter remains the source of truth.

The runtime is still initialized with both GitHub themes and `langs: []`.
H2 does not create a second highlighter for languages.

## 9. Single-flight loading

`ensureShikiLanguage()` follows this contract:

1. If the canonical ID is already loaded, return without calling
   `loadLanguage()`.
2. If the canonical ID is in `inFlightLanguageLoads`, return the existing
   Promise.
3. Otherwise create one Promise, store it under the canonical ID, and call
   `runtime.loadLanguage(trustedCanonicalLoader)`.
4. On success, synchronize from Shiki and mark the canonical ID loaded.
5. On success or failure, remove only that Promise from the in-flight map.

`prepareShikiLanguages()` resolves and deduplicates one document's aliases
before starting `Promise.all()`. Therefore `js + javascript`, `py + python`
and `yml + yaml` each create one grammar preparation job. Different canonical
languages can proceed concurrently, while same-language callers share one
Promise.

The focused runtime tests cover same-language concurrency, alias concurrency,
three different languages in parallel, repeated preparation and the one-
highlighter invariant.

## 10. Unknown and failure semantics

| Input/failure | H2 result | Runtime impact |
| --- | --- | --- |
| empty info | skipped | no runtime or grammar load |
| exact `markmap` | skipped as special | no Shiki grammar request |
| exact `mermaid` | skipped as special | no Shiki grammar request |
| `mmap`, `merm`, `mark-map`, `mer-maid` | unsupported | no special mount and no grammar request |
| unknown identifier | unsupported | no runtime/load rejection |
| runtime/highlighter initialization failure (`getShikiRuntime()` / `createHighlighter()`) | current preparation/render rejects | rejected singleton promise and the language in-flight entry are cleared; later preparation may retry |
| known grammar loader failure (`runtime.loadLanguage()`) | `unavailable` | singleton remains healthy; current highlight.js path remains usable; later call retries |
| no eligible supported fence | no preparation | Shiki runtime is not initialized |

Runtime/highlighter initialization errors are intentionally not caught by the
per-language grammar recovery path. They remain visible through the current
async preparation/render rejection surface, while the H1 singleton retry logic
clears its rejected promise. The surrounding in-flight language entry is also
removed on rejection, so the next request can initialize a fresh runtime.

Known language load errors are caught only around `runtime.loadLanguage()` and
returned as `unavailable`. H2 leaves the current highlight.js render path
intact, so a grammar preparation failure cannot break the existing document
renderer. Transient known failures are not inserted into the unsupported cache.
A later call can retry the same canonical loader without recreating the
highlighter. Unknown identifiers are deterministic registry misses and never
initialize Shiki or call `loadLanguage()`.

The test-only reset increments a generation token. A completion from a load
started before reset cannot mark the next runtime's loaded set or in-flight
map.

## 11. Resolver-side-effect evidence

The H2 Markdown tests render this shape with a resolver spy:

````markdown
[[Some Note]]

[Standard Link](some-note.md)

```js
const value = 1
```
````

The final render invokes the real resolver exactly twice: once for the wiki
link and once for the internal Markdown link. The preflight contributes zero
caller-resolver calls. The test asserts both the call count and the resulting
targets, not only the final HTML.

The existing concurrent resolver-isolation coverage remains, with an H2 case
that includes a JavaScript fence in both concurrent documents.

## 12. Concurrency evidence

The focused runtime tests prove:

| Scenario | Evidence |
| --- | --- |
| `js + js + js` concurrently | one `loadLanguage()` call and one factory call |
| `js + javascript` concurrently | one canonical JavaScript job |
| `js + py + yml` in one document | three canonical jobs, no alias duplicates |
| `js + java + python` concurrently | three load calls can be active concurrently |
| first known load rejects, second retries | same singleton remains usable; second load succeeds |
| runtime already reports `javascript` | preparation returns already-loaded without a second load |
| reset while a load is pending | stale completion cannot affect the next runtime |

The actual Shiki runtime test starts with `getLoadedLanguages() === []`,
prepares only `javascript`, then observes Java remains unloaded. It does not
assert an exact post-load array because Shiki legitimately reports aliases
alongside the canonical grammar.

The H2 follow-up regression additionally proves that a first
`createHighlighter()` rejection rejects `ensureShikiLanguage()` rather than
returning `unavailable`; the next request creates a second healthy runtime,
loads the grammar once and succeeds. The existing grammar-failure regression
continues to prove the separate per-language `unavailable` and retry contract.

## 13. Markdown regression evidence

The H2 integration preserves the existing renderer boundary:

```text
normal Markdown fence HTML → <pre class="hljs"><code>…</code></pre>
Shiki codeToHtml in normal Markdown → none
```

The focused command was:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/shiki.test.ts \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/markmapSecurity.test.ts
```

Result: `3 files passed; 63 tests passed`.

The H2 failure-semantics follow-up reran the same focused command after adding
the runtime-initialization rejection regressions:

```text
3 files passed; 65 tests passed
```

The suite covers known fences, metadata, unknown and false-positive input,
empty fences, MarkMap, Mermaid, similar-but-not-special names, escaped
fallback under the existing renderer, resolver counts and concurrent resolver
isolation. DOMPurify, theme CSS, PDF code, Mermaid components and MarkMap
runtime code were not changed.

## 14. Bundle and chunk evidence

The required build was:

```bash
npm run build
```

Result: `PASS`; Vite transformed `4,126` modules. Existing Rolldown
`INVALID_ANNOTATION` warnings from `@vueuse/core` and the existing large-chunk
warning remain.

Compared with the H1 evidence, the main application and Markdown chunks stay
effectively flat while the Vault route now carries the production-connected
Shiki registry/runtime boundary:

| Asset/chunk | H1 baseline | H2 result | Observation |
| --- | ---: | ---: | --- |
| Main app JS | 231.72 kB / 77.95 kB gzip | 231.72 kB / 77.96 kB gzip | no meaningful eager main-entry increase |
| Markdown chunk | 3.63 kB / 1.34 kB gzip | 3.63 kB / 1.34 kB gzip | existing Markdown chunk remains small |
| Vault route chunk | 1,712.61 kB / 484.60 kB gzip | 1,867.24 kB / 533.70 kB gzip | route includes H2 registry/runtime integration |
| Shiki runtime/core chunk | not emitted in H1 | `browser-DUg2Jr4t.js`: 206.32 kB / 77.37 kB gzip | new async route dependency |
| Oniguruma WASM chunk | not emitted in H1 | `wasm-BnjxR4X6.js`: 622.32 kB / 232.09 kB gzip | loaded by runtime engine when needed |
| Grammar chunks | none in H1 | 244 emitted grammar-like chunks; 10.77 MB raw / 2.18 MB gzip | async capability cost, not initial all-language execution |
| Theme chunks | none in H1 | 65 emitted theme chunks; 1.33 MB raw / 0.24 MB gzip | full official registry async capability cost |

The chunk inventory found `242` official bundled language metadata entries and
`244` emitted grammar-like assets containing grammar `scopeName` data. The
full JavaScript asset directory contains `405` JS assets; the H2 grammar and
theme totals above were calculated from the built `dist/assets` files using
raw size and gzip measurements.

The generated runtime contains trusted loader functions with dynamic imports
for individual grammar files. It does not statically import every grammar as
the runtime initializes. Runtime evidence also proves:

```text
new runtime             → getLoadedLanguages() is []
prepare javascript only → Java is not loaded
unknown language        → no loadLanguage call
```

The emitted async chunks are therefore recorded as bundle capability cost,
not evidence that all grammars execute at application startup.

## 15. Full-registry decision

H2 retains the full official `shiki` registry entry. A fine-grained bundle was
not adopted because H2 cannot replace the complete registry with a short list
without risking valid non-example Shiki languages, official aliases or future
grammar compatibility.

The accepted H2 tradeoff is:

```text
initial main entry  → effectively unchanged
route/runtime       → larger because the official registry is connected
grammar execution   → lazy per trusted registry loader
language support    → full official bundled set retained
```

H8 may revisit bundle optimization only with evidence that all valid Shiki
language support and aliases remain intact. H2 does not narrow product
semantics merely to reduce emitted async chunk count.

## 16. Known environment failures

The required full unit command was run:

```bash
npm run test:unit
```

Result: `FAIL` — `3 files failed, 208 passed`; `21 tests failed, 3,077
passed, 2 skipped`.

The failures match the H0/H1 environment limitation and remain server-only:

- 19 `server/__tests__/openai-http.test.ts` cases fail with
  `listen EPERM: operation not permitted 127.0.0.1`;
- one Round-15 crash-recovery case fails because the `tsx` child cannot listen
  on its temporary IPC pipe;
- one Round-16 crash-recovery case fails with the same `tsx` IPC `listen EPERM`
  signature.

No Shiki, Markdown, client, resolver, MarkMap, Mermaid or sanitizer failure
appeared. The result is recorded as `FAIL`, not converted to a pass.

## 17. H2 exit criteria

- [x] Discovery uses MarkdownIt `fence` tokens, not unrestricted raw Markdown regex.
- [x] Discovery uses a fresh isolated env without caller `wikiResolver`.
- [x] Final render uses a fresh real env.
- [x] Resolver double-call blocker is closed by explicit call-count tests.
- [x] Concurrent resolver isolation remains correct.
- [x] Exact `markmap` and `mermaid` fences bypass Shiki preparation.
- [x] Similar names remain non-special.
- [x] Empty info, metadata, whitespace and case normalization have deterministic behavior.
- [x] Official bundled registry and aliases are used without a hand-written allowlist.
- [x] Canonical loaded state and canonical in-flight single-flight are implemented.
- [x] Repeated and alias language requests deduplicate.
- [x] Different languages can load concurrently.
- [x] Unknown IDs do not call `loadLanguage()` and do not initialize the runtime.
- [x] Known load failures are retryable and do not poison the singleton.
- [x] Runtime initialization failures reject preparation, clear retry state and can succeed on the next request.
- [x] No user-controlled module import path exists.
- [x] Documents without eligible supported fences do not initialize Shiki.
- [x] Normal Markdown HTML remains the existing highlight.js contract.
- [x] DOMPurify, themes, PDF, Mermaid, MarkMap and highlight.js CSS are unchanged.
- [x] No generated Shiki CSS is injected into the DOM.
- [x] `npm run typecheck` passes.
- [x] Focused H2/runtime/Markdown tests pass: 63/63.
- [x] `npm run build` passes and the post-H2 bundle shape is recorded.
- [x] Full unit result and pre-existing environment failures are recorded honestly.
- [x] H1 completion SHA metadata is corrected to `7c020709eaeafb8dacd7db69adaa9dadfa4a4ae9`.
- [x] H3 renderer cutover and `codeToHtml` integration have not started.

## 18. H3 handoff

The next phase is:

```text
SHIKI-H3 — Markdown Renderer Cutover
```

H3 may use the already-prepared canonical language state and the existing
single transformer, then replace only the normal highlight.js callback with
Shiki output. H3 must preserve the isolated discovery/render env boundary and
the MarkMap/Mermaid checks before normal language handling.

Current handoff state:

```text
SHIKI-H0: COMPLETE
SHIKI-H1: COMPLETE
SHIKI-H2: COMPLETE
Fence discovery: READY
Dynamic language loading: READY
Resolver double-parse blocker: CLOSED
Shiki production runtime: CONNECTED
Markdown renderer: highlight.js
H3 codeToHtml integration: NOT STARTED
```
