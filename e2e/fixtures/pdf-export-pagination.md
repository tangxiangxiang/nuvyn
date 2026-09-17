---
title: PDF Pagination Regression
---

# PDF Paragraph Pagination Regression

H6_PAGINATION_BEGIN

This deterministic paragraph is part of the pagination calibration content. It keeps the document close to a real note while leaving the boundary probes to determine their own position in the current browser.

H6_FILLER_01 — 中文 English 日本語 and a fixed line of text keep the page-boundary regression independent of random content.

H6_FILLER_02 — The calibration uses real Markdown paragraphs and no generated height or timestamp.

H6_BOUNDARY_PROBE_001_BEGIN \
probe 001 line 01 \
probe 001 line 02 \
probe 001 line 03 \
probe 001 line 04 \
probe 001 line 05 \
probe 001 line 06 \
probe 001 line 07 \
probe 001 line 08 \
probe 001 line 09 \
probe 001 line 10 \
probe 001 line 11 \
probe 001 line 12 \
probe 001 line 13 \
probe 001 line 14 \
probe 001 line 15 \
probe 001 line 16 \
H6_BOUNDARY_PROBE_001_END

H6_BOUNDARY_PROBE_002_BEGIN \
probe 002 line 01 \
probe 002 line 02 \
probe 002 line 03 \
probe 002 line 04 \
probe 002 line 05 \
probe 002 line 06 \
probe 002 line 07 \
probe 002 line 08 \
probe 002 line 09 \
probe 002 line 10 \
probe 002 line 11 \
probe 002 line 12 \
probe 002 line 13 \
probe 002 line 14 \
probe 002 line 15 \
probe 002 line 16 \
probe 002 line 17 \
probe 002 line 18 \
H6_BOUNDARY_PROBE_002_END

H6_BOUNDARY_PROBE_003_BEGIN \
probe 003 line 01 \
probe 003 line 02 \
probe 003 line 03 \
probe 003 line 04 \
probe 003 line 05 \
probe 003 line 06 \
probe 003 line 07 \
probe 003 line 08 \
probe 003 line 09 \
probe 003 line 10 \
probe 003 line 11 \
probe 003 line 12 \
probe 003 line 13 \
probe 003 line 14 \
probe 003 line 15 \
probe 003 line 16 \
probe 003 line 17 \
probe 003 line 18 \
probe 003 line 19 \
probe 003 line 20 \
H6_BOUNDARY_PROBE_003_END

## H6_TARGET_HEADING

H6_TARGET_PARAGRAPH_BEGIN 这是一个用于验证 PDF 分页的普通段落。This paragraph must remain intact across the page boundary. 这里包含中文 English 日本語，确保字体和 line box 都被覆盖。The final fixed sentence keeps the marker easy to find in the generated PDF. H6_TARGET_PARAGRAPH_END

H6_AFTER_TARGET

This second paragraph proves that heading grouping is limited to the first meaningful content block rather than wrapping the whole section.

## H6_LIST_HEADING

- H6_LIST_ITEM_001 — short list items keep their own line boxes together.
- H6_LIST_ITEM_002 — 中文 English 日本語 remain ordinary rendered list content.
- H6_LIST_ITEM_003 — the list is not protected as one unbounded block.

H6_PAGINATION_END
