# Nuvyn VitePress-Style Markdown Extensions
# MD-EXT-5 — Code Groups

## 1. Audit metadata

| Field | Value |
| --- | --- |
| Phase | MD-EXT-5 |
| Status | COMPLETE / REVIEW-CLOSED |
| Implementation baseline | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| Previous phase review closure | 57919e17e61bb10aea8530093386562d2ac02062 |
| MD-EXT-5 base | 57919e17e61bb10aea8530093386562d2ac02062 |
| Original MD-EXT-5 implementation | bd4a1eb458e68f18a9e1329e94f7080b7eec1062 |
| Approved PRD | 7e05e3bb43f4283a90ead1abd0c81325bc93281c |
| Approved Implementation Plan | 582e312a4c5752a4c9a5c6bba7b0e752b0b78078 |
| MD-EXT-5 completion commit | Recorded in the final handoff after this commit is created |
| Next | MD-EXT-6 — NOT STARTED |

The MD-EXT-5 base is the reviewed MD-EXT-4 closure commit. The implementation
baseline remains the immutable approved-plan SHA; it is not rewritten to the
phase base or to this phase's eventual completion commit.

## 2. Scope and changed files

Implemented only the approved static code-group subset:

- `::: info`-style code-group syntax is limited to the exact `code-group` type;
- labeled ordinary fenced-code members, including empty members;
- static tab/panel HTML with all panels emitted;
- root-scoped reader click and keyboard enhancement;
- exact sanitizer additions for the generated controls;
- source-order all-panel PDF preparation;
- focused Markdown, lifecycle, PDF, and browser evidence.

No resources/includes, line-number syntax, code-group persistence, copy button,
Vue-in-Markdown, or MD-EXT-6 behavior was added.

Files changed by this phase:

```text
src/lib/markdownContainers.ts
src/lib/markdownCodeGroups.ts
src/lib/markdown.ts
src/lib/wikiLinks.ts
src/components/vault/RenderedMarkdown.vue
src/composables/useCodeGroupMount.ts
src/style.css
src/lib/pdfExport.ts
src/lib/__tests__/markdownCodeGroups.test.ts
src/composables/__tests__/useCodeGroupMount.test.ts
src/lib/__tests__/pdfExport.test.ts
e2e/markdown-extensions-md-ext-5.spec.ts
docs/README.md
docs/design/vitepress-markdown-extensions-implementation-plan.md
docs/design/vitepress-markdown-extensions-md-ext-5-code-groups.md
```

`package.json`, `package-lock.json`, `server/**`, `shared/**`, `src/lib/shiki.ts`,
`src/shiki.css`, and `src/lib/fenceMeta.ts` were not changed. The existing
MarkdownIt/Shiki/FenceMeta architecture remains the owner of normal code fences.

## 3. Parser and token architecture

The implementation is a Nuvyn-owned MarkdownIt block rule named
`nuvyn-code-group`, registered by name before the existing `nuvyn-container`
rule. It does not preprocess the complete source, reparse final HTML, or create
a second MarkdownIt instance.

The opener grammar is deliberately narrow:

```text
three-or-more-colons + horizontal whitespace + exact lower-case code-group
```

Longer colon runs are accepted. Titles, braces, generic attributes, case
variants, and arbitrary type names are not accepted. The rule reuses the
MD-EXT-2 opaque fence/close scanner and validates the complete body before
committing tokens. A valid body contains only blank lines and ordinary labeled
fenced-code blocks. Each member must have a non-empty `FenceMeta.label` and no
malformed fence metadata; an empty code body is valid.

The body is then tokenized by the current MarkdownIt block tokenizer. Members
remain ordinary `fence` tokens, so the existing FenceMeta discovery, Shiki
language preparation, annotations, line numbers, unknown-language fallback,
and code escaping all remain in the existing fence path. The parser attaches
only normalized private metadata:

```text
group index
panel index
validated display label
```

The group counter lives in a Symbol-keyed object in the current parse env. It is
not module-global and is not shared across concurrent parses. The source and
render paths therefore remain:

```text
md.parse(markdown, isolated discovery env)
  → discover ordinary member fence tokens
  → prepare Shiki languages
md.render(markdown, fresh real env)
  → code-group tokens + ordinary fence tokens
  → existing Shiki/Mermaid/MarkMap/math/callout renderers
  → DOMPurify
```

Labeled `mermaid` and `markmap` members are not exact bare special fences, so
they remain ordinary labeled code samples rather than mount placeholders. A
bare special fence outside a group remains unchanged.

Malformed, mixed-prose, unlabeled, titled, unknown-type, or unclosed groups
return `false` from the block rule and remain ordinary Markdown fallback. An
unknown type never becomes a source-derived CSS class.

## 4. Static DOM and ID contract

The renderer emits one fixed Nuvyn-owned structure per group:

```html
<div class="nuvyn-code-group" role="group" aria-label="Code examples">
  <div class="nuvyn-code-group-tabs" role="tablist">
    <button role="tab" type="button" aria-selected="true"
            aria-controls="...-panel-0" tabindex="0">TypeScript</button>
    <button role="tab" type="button" aria-selected="false"
            aria-controls="...-panel-1" tabindex="-1">JavaScript</button>
  </div>
  <div class="nuvyn-code-group-panels">
    <div role="tabpanel" aria-hidden="false">...</div>
    <div role="tabpanel" aria-hidden="true">...</div>
  </div>
</div>
```

All panels are emitted. The first panel is active initially. Labels are escaped
display text and never participate in ID generation. IDs use an opaque,
per-render scope plus deterministic group/panel indexes. A separate render
gets a separate scope; groups within one render share the scope but have
different group indexes. No `data-*` ID bridge or source-derived class exists.

## 5. Reader enhancement and accessibility

`src/composables/useCodeGroupMount.ts` owns only post-`v-html` behavior:

- each article root gets its own delegated `click` and `keydown` listeners;
- each root gets its own child-list/subtree MutationObserver;
- groups and tabs are resolved by ownership and exact `aria-controls` IDs;
- one valid selected tab and one visible panel are maintained;
- ArrowLeft/Right/Up/Down, Home, End, Enter, and Space are supported;
- roving `tabindex` is preserved;
- rerender and component unmount disconnect observers and listeners;
- separate article surfaces cannot share active state.

Theme changes remain CSS-only. The code-group mount does not retokenize code,
rerender Markdown, persist active tabs, or create Vue components inside the
sanitized article.

## 6. Sanitizer and security boundary

The exact MD-EXT-5 sanitizer delta is:

```text
tag:  button
attrs: aria-selected, aria-controls, aria-labelledby, tabindex
```

`role`, `id`, `type`, `class`, and the existing semantic attributes were already
allowed. The sanitizer still has `FORBID_ATTR: ['style']`; event attributes,
unknown data attributes, scripts, SVG, and generic attribute syntax remain
blocked. The `tabindex` hook now explicitly retains only the fixed roving values
`0` and `-1` and removes every other author value under the existing DOMPurify
policy; it is not a generic value bridge. The final-render regression covers
`999`, `1`, `-2`, `abc`, `01`, and `+1` removal, while `0` and `-1` survive for
both buttons and non-button elements. Generated code-group tabs still retain
their `0`/`-1` roving values.

Labels are escaped before they enter generated button text. PDF labels use
`textContent`, not `innerHTML`. No inline event handler, inline style, source
CSS value, or author-controlled ID is generated.

Existing external-link provenance, custom-anchor source awareness, callouts,
DOMPurify hooks, and `FORBID_ATTR` behavior remain unchanged.

## 7. Existing feature coexistence

The existing `> [!...]` callout plugin remains authoritative and is not replaced.
Callouts and code groups use separate syntax and can be nested through normal
MarkdownIt block parsing. Containers can contain code groups when delimiter
length disambiguates the outer close. Ordinary fenced code, headings/TOC,
WikiLinks, Markdown links/images, math, Shiki annotations/line numbers, and
unknown-language fallback remain on their existing paths.

## 8. PDF contract

`preparePdfCodeGroups()` runs on the already-cloned article. It never mutates the
live reader, rereads Markdown/resources, or rerenders Shiki. For a structurally
valid generated group it:

1. maps each tab's exact `aria-controls` to its own panel;
2. iterates panels in source DOM order;
3. creates a printable label from the tab's `textContent`;
4. marks every panel active/visible and removes the tablist from the clone;
5. preserves the existing Shiki line/token/annotation DOM inside each panel.

Malformed lookalikes are left untouched rather than dropping content. Printable
styles hide the tablist, show every panel, keep labels readable in a light
palette, and allow an oversized panel item to split through the existing
`pdf-allow-split` mechanism. The live reader's selected tab remains unchanged.

## 9. Validation evidence

The phase-owned browser spec is:

```text
e2e/markdown-extensions-md-ext-5.spec.ts
```

It proves static DOM/ARIA, real root-scoped click and keyboard behavior,
independent groups, hostile-label text handling, unknown fallback, labeled
Mermaid/MarkMap non-special behavior, theme/no-rerender stability, and PDF
all-panel/source-order export without reader mutation.

Focused unit coverage is in:

```text
src/lib/__tests__/markdownCodeGroups.test.ts
src/composables/__tests__/useCodeGroupMount.test.ts
src/lib/__tests__/pdfExport.test.ts
```

Observed command results on the MD-EXT-5 tree:

| Command | Result |
| --- | --- |
| focused Vitest (`markdownCodeGroups`, `useCodeGroupMount`, Markdown/container/PDF) | PASS — 5 files, 118 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 3,935 modules transformed |
| focused MD-EXT-5 Playwright | PASS — 2 tests |
| existing MD-EXT-1 through MD-EXT-4, Shiki security/theme, PDF Shiki | PASS — 13 tests |
| PDF export/layout/pagination/stress | PASS — 11 tests |
| `npm run test:unit` | BASELINE-LIMITED — 212 files passed, 3 failed; 3,172 passed, 21 failed, 2 skipped |

The 21 full-unit failures are the unchanged baseline environment failures: 19
OpenAI HTTP loopback `listen EPERM`, one Round-15 `tsx` IPC `EPERM`, and one
Round-16 `tsx` IPC `EPERM`. No Markdown, code-group, Shiki, callout, client, or
PDF product regression appeared. The aggregate command remains recorded as
baseline-limited, not green.

The build retained the existing Rolldown `@vueuse/core` `INVALID_ANNOTATION`
warning and existing >500 kB chunk warnings. It did not introduce a new warning
class.

## 10. Bundle comparison

The production build contains 467 asset files, including 404 JavaScript assets
and 3 CSS assets. Compared with the MD-EXT-4 build evidence:

| Asset surface | MD-EXT-4 baseline | MD-EXT-5 build | Change |
| --- | ---: | ---: | ---: |
| VaultView JS | 1,893.05 kB / 541.26 kB gzip | 1,901.88 kB / 543.62 kB gzip | +8.83 / +2.36 kB |
| application entry JS | 231.72 kB / 77.95 kB gzip | 231.72 kB / 77.96 kB gzip | gzip noise |
| main CSS | 136.99 kB / 27.73 kB gzip | 138.28 kB / 27.97 kB gzip | +1.29 / +0.24 kB |

The increase is the narrow reader mount/static container CSS and PDF integration.
There is no new dependency, no second MarkdownIt/Shiki runtime, and no eager
all-language architecture change; Shiki grammar chunks remain split.

## 11. Rollback boundary and next phase

Reverting this phase removes only the code-group block rule, static tab/panel
renderer, reader mount/CSS, PDF clone expansion, sanitizer delta, tests, and
evidence. MD-EXT-1 through MD-EXT-4, H8 Shiki, existing containers/callouts,
Mermaid/MarkMap/math, and the existing PDF baseline remain available.

```text
MD-EXT-5: COMPLETE / REVIEW-CLOSED
MD-EXT-6: NOT STARTED
```

## 12. Review follow-up closure

The original MD-EXT-5 implementation is recorded at:

```text
bd4a1eb458e68f18a9e1329e94f7080b7eec1062
```

This follow-up closes the two review findings without changing the code-group
parser, reader mount, Shiki/FenceMeta path, or PDF production implementation.

### Sanitizer value boundary

The final `MarkdownIt → DOMPurify` path now enforces the exact attribute-value
contract:

```text
tabindex="0"   → retained
tabindex="-1"  → retained
all other tabindex values → removed
```

The regression is attribute-wide: invalid values are removed from raw
`<button>` and `<div>` elements, while generated code-group tabs keep their
roving `0`/`-1` values. `FORBID_ATTR: ['style']`, event-attribute blocking, and
the narrow `data-*` allowlist are unchanged.

### Grouped PDF integration proof

The MD-EXT-5 Chromium PDF test now uses a real grouped fixture:

```markdown
::: code-group
```ts {2}:line-numbers=98 [TypeScript]
const first = 1
const second = 2 // [!code error]
```
```js [JavaScript]
console.log('js')
```
:::
```

The reader selects the non-first JavaScript tab before export. The PDF clone
still contains both panels and labels in TypeScript/JavaScript source order,
while the live reader selection and HTML remain unchanged. In the grouped
TypeScript panel the test observes visible gutter text `98` and `99`, the real
`.line.error` class, and a non-transparent printable annotation background.
It also reads a real Shiki token in Chromium: its computed foreground equals
the normalized `--shiki-light` value and differs from `--shiki-dark`, proving
that a dark reader palette does not leak into the grouped PDF surface.

Follow-up validation:

| Command/surface | Result |
| --- | --- |
| focused Vitest (`markdown`, code groups, PDF, mount) | PASS — 4 files, 97 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 3,935 modules transformed; existing warnings only |
| `npm run test:unit` | BASELINE-LIMITED — 212 files passed, 3 failed; 3,173 passed, 21 failed, 2 skipped |
| `e2e/markdown-extensions-md-ext-5.spec.ts` | PASS — 2 tests |
| MD-EXT-3/4, MD-EXT-5, PDF Shiki/general/layout/pagination/stress E2E | PASS — 19 tests |

MD-EXT-5 is therefore review-closed. MD-EXT-6 remains not started.
