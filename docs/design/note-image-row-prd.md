# Nuvyn Note Image Row

**Status:** Superseded by the unified Flex container (2026-10-13)
**Scope:** Markdown rendering and PDF export for ordinary Notes

> Historical design record only. The `image-row` parser and styles have been
> removed. A check of the current `src/content` vault found no stored-note
> usage. New layouts use the single `flex` syntax documented in
> `note-flex-container-prd.md`.

## Goal

Allow multiple existing Note image references to be presented side by side
without changing the Markdown-first editing model or the underlying attachment
files. This is a rendering layout only: users continue to edit plain Markdown
in Monaco, and the feature adds no toolbar, drag sorting, or image-management
behavior.

## Syntax

Use a closed `image-row` container with at least two standalone Markdown image
paragraphs:

```md
::: image-row

![Architecture A](@/attachments/images/a.png)

![Architecture B](@/attachments/images/b.svg)

:::
```

Blank lines between image lines are allowed. Each non-empty source line must
parse as exactly one standard Markdown image token. PNG, JPEG, WebP, GIF, AVIF,
and the existing safe SVG flow use their normal resource resolution and
attachment-reference semantics. There is no title or layout-parameter syntax.

Rows with fewer than two images, a title, text, code, a table, nesting, or no
closing marker are not converted into the special layout; the Markdown source
continues through the regular parser so content is not silently discarded.
More than four images are allowed and wrap naturally as space permits.

## Rendering

The parser emits a plain `div.nuvyn-image-row`; its children are ordinary
Markdown-generated image paragraphs. The wrapper has no callout/card title,
background, border, or padding. CSS Grid uses equal-width columns with a
minimum comfortable column size, preserves image aspect ratios, caps images at
the available width, and does not enlarge small assets. At narrow phone widths
the grid becomes a single vertical column. The wrapper and images are
constrained to the article width to avoid horizontal page overflow.

PDF export has independent print rules for the same grid, sizing and image
proportion behavior. A row is kept together when it fits a printable page; an
oversized group may split rather than being clipped.

## Resources and security

Each image remains a normal Markdown image token, so the existing authenticated
resource resolver, lazy loading, upload APIs, and attachment reference index
remain in use. Source-line and Include provenance continue to come from the
existing Markdown resource pipeline. The feature neither duplicates nor
re-uploads attachments.

The container name is part of a fixed parser allowlist; it does not accept
author-provided classes or CSS. The normal final DOMPurify pass remains in
place. `style` attributes, raw SVG, event handlers, unsafe URLs, and unsafe
HTML are not enabled for this feature. Invalid row contents fall back to
ordinary Markdown parsing.

## Non-goals

- Rich-text or block-editor controls.
- Image upload or attachment lifecycle changes.
- Per-image sizing, crop mode, alignment, custom gaps, or custom CSS.
- Drag-and-drop ordering or a permanent image gallery.
- Changes to single standalone Markdown image rendering.

## Acceptance criteria

- Two through four mixed PNG/SVG images render as normal Markdown images in a
  responsive grid; additional images wrap without a hard limit.
- A lone image outside the container retains existing rendering.
- Invalid or unclosed rows do not lose text or images.
- Wide screens show images in columns; narrow mobile widths stack them with no
  horizontal page overflow.
- Images retain proportions and stay within the article/PDF page width.
- Include expansion, source line mapping, direct/indirect Attachment Manager
  references, and authenticated image loading remain unchanged.
- DOMPurify and the Note SVG safety profile are not weakened.
