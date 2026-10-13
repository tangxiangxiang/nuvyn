# Nuvyn Note Flex Container

**Status:** Implemented (Unified Flex V1)  
**Scope:** Controlled Markdown block layout for Notes and PDF export

## Product decision

Nuvyn has one author-facing layout container: `flex`. There is no `flex-item`
container syntax. Every direct Markdown block inside a Flex container is an
implicit Flex item. A nested `flex` container can group multiple blocks into a
single item while also arranging its own children.

The former `image-row` feature was checked against the current `src/content`
vault and had no stored-note usage. Its parser and dedicated styles were
removed; images use Flex like every other layout. The historical
`note-image-row-prd.md` is retained as a superseded design record.

## Basic syntax

Separate independent Markdown blocks with blank lines:

```md
::: flex

![Architecture A](@/attachments/images/a.png)

![Architecture B](@/attachments/images/b.svg)

:::
```

Each standalone image paragraph is a direct Flex item. The same rule applies
to normal paragraphs, headings, lists, code blocks, tables, callouts, Mermaid,
and other rendered block elements. A soft line break remains within the same
paragraph and does not create another item.

## Nested layout

Use a nested Flex container when several blocks should be grouped as one item:

```md
:::: flex direction=row wrap=wrap gap=16

::: flex direction=column grow=1 basis=50%

![System architecture](architecture.svg)

:::

::: flex direction=column grow=1 basis=50%

### System architecture

The design contains a frontend, backend, and database.

- Vue 3
- Hono
- SQLite

:::

::::
```

An inner Flex has both roles without a second syntax:

- Its `grow`, `shrink`, `basis`, `self`, and `order` values size the nested
  container as one item in its parent.
- Its `direction`, `wrap`, `justify`, `items`, `content`, `gap`, and `mobile`
  values arrange its own direct Markdown blocks.

Use longer colon fences at deeper levels when that makes ownership clearer.

## Controlled values

Attributes are space-separated `name=value` pairs. Duplicate, unknown,
malformed, or out-of-range values invalidate the layout; no author value is
interpolated into CSS.

| Attribute | Allowed values | Default |
| --- | --- | --- |
| `direction` | `row`, `row-reverse`, `column`, `column-reverse` | `row` |
| `wrap` | `nowrap`, `wrap`, `wrap-reverse` | `wrap` |
| `justify` | `normal`, `start`, `end`, `flex-start`, `flex-end`, `center`, `left`, `right`, `stretch`, `space-between`, `space-around`, `space-evenly`, safe/unsafe position variants | `flex-start` |
| `items` | `normal`, `stretch`, `baseline`, `first-baseline`, `last-baseline`, `start`, `end`, `self-start`, `self-end`, `flex-start`, `flex-end`, `center`, safe/unsafe self-position variants | `stretch` |
| `content` | `normal`, `stretch`, baseline variants, `start`, `end`, `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`, safe/unsafe position variants | `stretch` |
| `gap` | `0`, `4`, `8`, `12`, `16`, `24`, `32` pixels | `16` |
| `grow` | integer `0`–`4` | `0` |
| `shrink` | integer `0`–`4` | `1` |
| `basis` | `auto`, `0`, `25%`, `33.33%`, `50%`, `66.67%`, `75%`, `100%` | `auto` |
| `self` | `auto`, `stretch`, `baseline`, `start`, `end`, `self-start`, `self-end`, `flex-start`, `flex-end`, `center`, safe/unsafe self-position variants | `auto` |
| `order` | integer `-3`–`3` | `0` |
| `mobile` | `stack`, `preserve` | `stack` |

Compound alignment keywords use hyphens in Markdown (`items=first-baseline`,
`justify=safe-center`) and are rendered as their CSS-standard values. Arbitrary
CSS, custom classes, inline styles, `calc()`, `var()`, URLs, and expressions are
not supported.

## Markdown parsing and fallback

The existing MarkdownIt container plugin scans the Flex fence while respecting
code fences, indented code, math, HTML block ownership, and other custom
containers. It then tokenizes the body through the normal block rules; it does
not split paragraphs by source lines or wrap tokens in a second author-facing
container. Each actual direct block token therefore remains one layout child.

Nested Flex delimiters are recursively matched, whether a child uses shorter
or longer colon fences. Empty, unclosed, and invalid-attribute Flex syntax
falls back to ordinary Markdown and does not swallow content. A removed
`image-row` or `flex-item` opener is not recognized as a layout container.

## Security and rendering

The parser emits a fixed class set from strict enumerations. Container CSS and
parent-item sizing classes are kept only when the per-render opaque Flex
provenance matches a parser-generated wrapper. DOMPurify remains unchanged as
the final boundary; raw HTML cannot forge a Flex container or its layout
classes. Temporary provenance attributes are removed before output. No
`style` attributes, unsafe SVG, URLs, or untrusted CSS values are enabled.

Images, Board references, Includes, WikiLinks, code, and other Markdown
features continue through the existing rendering and resource pipeline. The
Attachment Reference Index sees the same image tokens and Include source map;
Flex neither copies nor uploads resources.

## Responsive layout and PDF

Desktop rendering follows the validated authored layout. `mobile=stack` is the
default and changes horizontal directions to a vertical stack when the Note
article itself is at most 600 px wide. `mobile=preserve` keeps the authored
direction and contains horizontal overflow. The query follows available
content width, not the device viewport.

PDF export has an independent Flex stylesheet so it does not depend on Reader
CSS. It preserves allowed layout values, keeps content within printable width,
and leaves oversized content to the existing PDF split handling rather than
hiding overflow.

## Accessibility and limitations

DOM order follows Markdown source order. Reverse directions and `order` affect
visual layout only; they must not express important reading order. Flex has no
visual editor, per-item wrapper syntax, arbitrary lengths, custom CSS, or
special image grid. Use blank-line-separated blocks for simple layouts and
nested Flex to group multiple blocks.

## Verification

Coverage includes all supported layout values, nested containers, malformed
fallback, normal Markdown block semantics, sanitizer provenance, Include and
attachment source mapping, narrow-content geometry, and PDF clone layout.
Chromium and WebKit verification is reported only for browsers actually run.
