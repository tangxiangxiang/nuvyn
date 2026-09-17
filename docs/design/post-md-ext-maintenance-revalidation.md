# Post-MD-EXT Maintenance Revalidation

## Metadata

| Field | Value |
| --- | --- |
| Status | COMPLETE / REVIEW-CLOSED |
| Repository | `tangxiangxiang/nuvyn` |
| Branch | `main` |
| Historical MD-EXT-7 release-gate baseline | `810ad55941d2a5df8a91d5728d51ebbeb0196aa3` |
| Historical MD-EXT production closure baseline | `fc78da8b0dd23e5b543ed346b5bf63032778c181` |
| Revalidation input HEAD | `734ab9b1c11ba8c83aac445ec86bc49b3d087a41` |
| Validated implementation baseline | `a6bed596eadc0437ef4d488c21c799feeee04f69` |
| Date | 2026-08-24 |

The revalidation started from `734ab9b1c11ba8c83aac445ec86bc49b3d087a41`.
The corrections and evidence produced by that revalidation were committed as
`a6bed596eadc0437ef4d488c21c799feeee04f69`. Therefore
`a6bed596eadc0437ef4d488c21c799feeee04f69` is the validated implementation
baseline for this Post-MD-EXT maintenance review. The follow-up commit that
updates this evidence document is documentation-only and is not itself a new
implementation baseline.

This document records a new validation pass for the current post-closure
maintenance state. It does not rewrite or reopen MD-EXT-7. MD-EXT-7 remains a
historical release-gate record for its original baseline and review decision.

## Scope

The revalidation covers the current Markdown maintenance surface:

- strict five-type GitHub-style Alert semantics and localized display titles;
- removal of the inline `[[toc]]` extension and ordinary WikiLink fallback;
- Alert and custom-container reader/PDF visual surfaces;
- bounded Markdown resource selection;
- Shiki code surfaces, language labels, and light/dark behavior;
- line-number, focus, diff, highlight, error, and warning annotations;
- static code groups and their PDF export;
- Markdown sanitization and the narrow `data-language` allowlist;
- Markdown, resource/include, visual, and PDF regression lanes.

The current HEAD also contains the independent content-scope navigation change;
that change is outside this Markdown revalidation scope.

## Current compatibility contract

### Alerts

Only exact, uppercase, marker-only first lines are Alerts:

```text
[!NOTE]       → 注意
[!TIP]        → 提示
[!IMPORTANT]  → 重要
[!WARNING]    → 警告
[!CAUTION]    → 小心
```

Lowercase, titled, folded, legacy, and unknown forms remain ordinary
blockquotes. The strict behavior is intentional and is documented in
[`markdown-post-md-ext-compatibility.md`](../migrations/markdown-post-md-ext-compatibility.md).

### Inline TOC

`[[toc]]`, `[[TOC]]`, and `[[Toc]]` do not create an inline navigation element.
They use the ordinary WikiLink resolver. Heading IDs and the right-side
document TOC remain separate and continue to use the final heading IDs.

### Security and resource bounds

The sanitizer continues to allow only the explicitly approved `data-language`
attribute, while rejecting generic data attributes, inline styles, event
handlers, unsafe URLs, scripts, iframes, and SVG. Resource selection continues
to enforce the existing UTF-8 byte limits before materializing output, including
duplicate/overlapping ranges, multibyte content, exact boundaries, separators,
and named regions.

## Revalidation results

| Area | Result |
| --- | --- |
| Typecheck | PASS |
| Production build | PASS — 3938 modules transformed; existing chunk-size and pure-annotation warnings only |
| Focused Markdown/Markdown-extension unit tests | PASS — 9 files / 267 tests |
| Focused scope unit tests | PASS — 2 files / 37 tests |
| Context-menu unit tests | PASS — 1 file / 12 tests |
| History integration | PASS — 5 files / 172 tests |
| Full `npm test` | BASELINE-LIMITED — 215 files passed, 3262 tests passed, 21 known environment EPERM failures, 2 skipped |
| Recovery integration | BASELINE-LIMITED — 158 tests passed; 35 known tsx IPC EPERM failures |
| Markdown Extensions 1–6 E2E | PASS — 21 tests |
| Markdown visual / Shiki / security E2E | PASS — included in the 31-test focused browser lane |
| PDF export / Shiki / layout E2E | PASS — included in the 31-test focused browser lane |
| Auth E2E | PASS — 2 tests |
| Full `npm run test:e2e` | NOT RUN — the relevant Markdown/PDF lane and authenticated lane were run instead of unrelated browser suites |
| Icon lint | FAIL — pre-existing 8 hard and 6 soft SVG rule violations; unrelated to this Markdown maintenance scope |

The browser lane also closed a real plain-Shiki fallback surface regression:
the trusted fallback selector now wins over theme selectors, so an unavailable
language fence keeps a visible code surface rather than resolving to a
transparent background. No Shiki transformer, token palette, PDF, or Markdown
syntax behavior was changed.

All validation above is local validation. No GitHub Actions or independent
GitHub status result is asserted here.

## Scope of changes in this revalidation

The maintenance correction was intentionally narrow:

- `src/shiki.css` — restore the visible plain-fallback surface under explicit
  theme-selector precedence;
- `src/components/vault/__tests__/context-menu.test.ts` — explicitly opt this
  unfiltered context-menu fixture out of the product's default `note` scope so
  its user-defined-folder assertion remains about context-menu behavior;
- current Markdown documentation, migration guidance, changelog, and this
  revalidation record.

No server, dependency, sanitizer, resource-path, Shiki-transformer,
FenceMeta, PDF architecture, or new Markdown feature was introduced.

## Residuals and next review state

No new task-scoped P0, P1, or P2 issue was found in the revalidation. The
icon-lint violations listed above predate this maintenance work and remain an
existing P2-quality backlog item outside this scope; they are not represented
as a passing lint result.

The independent review is complete, so the revalidation is therefore
`COMPLETE / REVIEW-CLOSED`. The historical MD-EXT-7 release-gate document
remains unchanged, and no MD-EXT-8 has been created.
