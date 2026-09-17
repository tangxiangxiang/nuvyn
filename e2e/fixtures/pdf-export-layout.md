---
title: PDF Layout Regression
---

# PDF Layout Regression

This fixture checks printable A4 layout without becoming a long-document stress test.

## Long Code Line

```text
H6_LONG_UNBROKEN_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

## Short Code Control

```text
H6_SHORT_CODE_MARKER
const printable = true
```

## Oversized Code Block

H6_BEFORE_OVERSIZED_BLOCK

```text
H6_OVERSIZED_CODE_BEGIN
line-001 preserve the complete oversized code block across printable pages
line-002 preserve the complete oversized code block across printable pages
line-003 preserve the complete oversized code block across printable pages
line-004 preserve the complete oversized code block across printable pages
line-005 preserve the complete oversized code block across printable pages
line-006 preserve the complete oversized code block across printable pages
line-007 preserve the complete oversized code block across printable pages
line-008 preserve the complete oversized code block across printable pages
line-009 preserve the complete oversized code block across printable pages
line-010 preserve the complete oversized code block across printable pages
line-011 preserve the complete oversized code block across printable pages
line-012 preserve the complete oversized code block across printable pages
line-013 preserve the complete oversized code block across printable pages
line-014 preserve the complete oversized code block across printable pages
line-015 preserve the complete oversized code block across printable pages
line-016 preserve the complete oversized code block across printable pages
line-017 preserve the complete oversized code block across printable pages
line-018 preserve the complete oversized code block across printable pages
line-019 preserve the complete oversized code block across printable pages
line-020 preserve the complete oversized code block across printable pages
line-021 preserve the complete oversized code block across printable pages
line-022 preserve the complete oversized code block across printable pages
line-023 preserve the complete oversized code block across printable pages
line-024 preserve the complete oversized code block across printable pages
line-025 preserve the complete oversized code block across printable pages
line-026 preserve the complete oversized code block across printable pages
line-027 preserve the complete oversized code block across printable pages
line-028 preserve the complete oversized code block across printable pages
line-029 preserve the complete oversized code block across printable pages
line-030 preserve the complete oversized code block across printable pages
line-031 preserve the complete oversized code block across printable pages
line-032 preserve the complete oversized code block across printable pages
line-033 preserve the complete oversized code block across printable pages
line-034 preserve the complete oversized code block across printable pages
line-035 preserve the complete oversized code block across printable pages
line-036 preserve the complete oversized code block across printable pages
line-037 preserve the complete oversized code block across printable pages
line-038 preserve the complete oversized code block across printable pages
line-039 preserve the complete oversized code block across printable pages
line-040 preserve the complete oversized code block across printable pages
line-041 preserve the complete oversized code block across printable pages
line-042 preserve the complete oversized code block across printable pages
line-043 preserve the complete oversized code block across printable pages
line-044 preserve the complete oversized code block across printable pages
line-045 preserve the complete oversized code block across printable pages
line-046 preserve the complete oversized code block across printable pages
line-047 preserve the complete oversized code block across printable pages
line-048 preserve the complete oversized code block across printable pages
line-049 preserve the complete oversized code block across printable pages
line-050 preserve the complete oversized code block across printable pages
line-051 preserve the complete oversized code block across printable pages
line-052 preserve the complete oversized code block across printable pages
line-053 preserve the complete oversized code block across printable pages
line-054 preserve the complete oversized code block across printable pages
line-055 preserve the complete oversized code block across printable pages
line-056 preserve the complete oversized code block across printable pages
line-057 preserve the complete oversized code block across printable pages
line-058 preserve the complete oversized code block across printable pages
line-059 preserve the complete oversized code block across printable pages
line-060 preserve the complete oversized code block across printable pages
line-061 preserve the complete oversized code block across printable pages
line-062 preserve the complete oversized code block across printable pages
line-063 preserve the complete oversized code block across printable pages
line-064 preserve the complete oversized code block across printable pages
line-065 preserve the complete oversized code block across printable pages
line-066 preserve the complete oversized code block across printable pages
line-067 preserve the complete oversized code block across printable pages
line-068 preserve the complete oversized code block across printable pages
line-069 preserve the complete oversized code block across printable pages
line-070 preserve the complete oversized code block across printable pages
line-071 preserve the complete oversized code block across printable pages
line-072 preserve the complete oversized code block across printable pages
line-073 preserve the complete oversized code block across printable pages
line-074 preserve the complete oversized code block across printable pages
line-075 preserve the complete oversized code block across printable pages
line-076 preserve the complete oversized code block across printable pages
line-077 preserve the complete oversized code block across printable pages
line-078 preserve the complete oversized code block across printable pages
line-079 preserve the complete oversized code block across printable pages
line-080 preserve the complete oversized code block across printable pages
H6_OVERSIZED_CODE_END
```

H6_AFTER_OVERSIZED_BLOCK

## Wide Table

| English | 中文 | 日本語 | LongToken | Number | Status | Description | Owner | Date | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| printable content | 宽内容测试 | 印刷レイアウト | H6_TABLE_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | 1024 | ready | a long cell that must wrap instead of widening the page | Nuvyn | 2026-08-20 | keep the final marker |
| second row | 混合文字 | 長いセル | H6_SECOND_LONG_TOKEN_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | 2048 | checked | another deterministic row with enough text to exercise wrapping | PDF | 2026-08-21 | no horizontal scroll |

## Wide Mermaid

```mermaid
flowchart LR
  A[Start export] --> B[Capture source]
  B --> C[Wait for widgets]
  C --> D[Wait for images]
  D --> E[Prepare A4 layout]
  E --> F[Render static SVG]
  F --> G[Create PDF]
  G --> H[Download result]
```

## Deep MarkMap

```markmap
# PDF Layout
## Source
### Markdown
#### Sanitized DOM
##### Stable snapshot
## Widgets
### Mermaid
#### Settled state
##### Static SVG
### MarkMap
#### Fit transform
##### Printable viewBox
## Output
### A4
#### Portrait
##### Final marker
```

PDF_LAYOUT_END_MARKER
