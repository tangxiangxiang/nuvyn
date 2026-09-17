# Naive UI Foundation — Phase 0 Remediation

**Date:** 2026-09-07
**Starting main:** `ff1f1bbdfad62175fa9b9b192d4760fce12728d2`
**Scope:** Phase 0 spike evidence only. No Phase 1 production integration.

## P1-1 — CSS-var derived-color boundary

The spike mounts a real `NConfigProvider` and `NInput` with these common theme
values supplied as CSS variables:

```text
primaryColor        var(--nuvyn-accent)
primaryColorHover   var(--nuvyn-accent-hover)
primaryColorPressed var(--nuvyn-accent-pressed)
```

Naive UI 2.45.3 fails during the real Input theme calculation. The observed
runtime error is:

```text
[seemly/rgba]: Invalid color value var(--nuvyn-accent)
```

The stack reaches `seemly.changeColor` from Naive's Input light theme. This is
not an object-only assertion. The working fixture therefore uses the smallest
compatibility mirror—only `primaryColor` is resolved—while explicit hover and
pressed colors remain CSS-variable-backed. `NCard` and the mounted controls
also retain the raw/surface CSS variables in generated runtime styles.

**Conclusion:** `MINIMAL TS MIRROR REQUIRED` for the base primary color used by
Naive's derived alpha calculation; no full Nuvyn token mirror.

## P1-2 — Control density

The fixture now maps:

```text
compact  → NButton size="small"  → n-button--small-type
default  → NButton default size  → n-button--medium-type
```

Default no longer uses `large`. The tests cover normal focusable controls,
disabled controls, loading controls, and distinct rendered size classes.

**Result:** `PASS`

## P1-3 — Focus gate

The browser probe imports the repository's actual `src/style.css`, uses real
Naive controls, and measures both mouse focus and keyboard Tab focus for
`NButton` and `NInput`.

Initial Chromium evidence shows:

- NButton: Nuvyn `2px solid` outline plus Naive `1px` focus border — double
  indicator confirmed.
- NInput: Nuvyn outline is suppressed by the Naive input primitive; Naive owns
  the focused border and `0 0 0 2px rgba(79, 70, 229, 0.2)` box shadow.

The same browser probe applies the smallest tested authority strategy: exclude
`.n-button` and `.n-input input` from the broad Nuvyn focus rule, leaving Naive
to render its own ring. The resolved probe has one focus indicator for both
controls. This override is test evidence only; production `src/style.css` is
not rewritten in Phase 0.

**Conclusion:** `CONFLICT CONFIRMED`; Phase 1 must choose a Naive-owned focus
authority strategy and adopt the tested primitive exclusion deliberately.

## P1-4 — Locale and dateLocale

General locale evidence continues to use `NEmpty` for `zhCN ↔ enUS` copy.
Independent date evidence mounts a real `NDatePicker` panel with
`locale=zhCN` fixed while toggling `dateLocale=dateZhCN ↔ dateEnUS`; the seven
weekday labels change between Chinese and English date-fns output and restore
when switched back. The main fixture also verifies the full `zh → en → zh`
runtime bridge without remounting its child.

```text
General locale: PASS
Date locale:    PASS
```

This remains a UI compatibility probe; Ledger date string and timezone domain
semantics are unchanged.

## P1-5 — exact-head CI

The failed Phase 0 run `34111048612` was inspected by job and step. The
Windows verify job exposed the Phase 0 timezone subprocess test's default
5-second Vitest timeout; the current main head already carries the targeted
30-second timeout adjustment in `ff1f1bb`. The macOS responsive failure was an
existing cross-platform browser flake and passed on the subsequent exact-head
run `34112600764` while this remediation was in progress.

Final Linux, macOS, and Windows results are reported only after the exact-head
run for the remediation commit completes.

## Regression evidence

The existing spike gates remain in place: exact dependency pins, provider and
overlay lifecycle, Tabler/NIcon rendering and accessibility, SSR, tree-shaking,
light/dark switching, locale bridge, Ledger `YYYY-MM-DD` formatting, and
representative timezone checks. No product page, router, store, server, API,
or domain semantics were changed.

## Review readiness

```text
P0: 0
P1: 0 after exact-head CI completes
Phase 0: READY FOR REVIEW
Ready for Phase 1: NO
```

This document does not declare Product Review acceptance and does not authorize
Phase 1 work.
