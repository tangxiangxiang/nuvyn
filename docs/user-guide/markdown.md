# Markdown, Links, and Diagrams

## Supported Markdown

Nuvyn renders Markdown with `markdown-it` and supports the core syntax plus:

- task lists;
- heading anchors;
- footnotes;
- definition lists;
- `==marked text==`;
- tables and syntax-highlighted code fences;
- automatic links;
- Wiki links;
- GitHub-style Alerts;
- KaTeX inline and block math;
- Mermaid and Markmap fences.
- live Board embeds.

## Structural folding

In edit mode, use Monaco's native gutter chevrons to fold headings (H1–H6)
and fenced code. Other structures rely on Monaco's existing behavior, without
dedicated Nuvyn folding rules. Native Fold All, Unfold All and Fold Level commands are available.
ATX and Setext headings follow the same hierarchy: a section ends at the next
heading of the same or higher level, within its enclosing container.

On desktop, folding chevrons appear when hovering over the corresponding
heading/block (or Monaco gutter). Reader controls also appear on keyboard
focus; touch devices keep controls visible. Revealing controls does not move
the content.

In reading mode, only section headings receive chevrons. A leading H1 is
treated as the document title and has no folding control; later H1 sections
and H2–H6 can fold until the next same/higher heading in their container.
Lists, quotes, code, layouts, Callouts, images, tables, diagrams and Board
previews receive no independent fold controls. Details and Code Group retain
their existing interactions. Fold buttons support Tab, Enter and Space,
including on touch devices.

Nested states are independent: expanding a parent does not unfold its children.
TOC links, internal anchors and Wiki-link anchor navigation reveal the necessary
ancestors before scrolling. The full H2–H4 outline remains available; hidden
headings do not participate in scroll tracking. Editor search/anchor reveals
also unfold the hidden ancestors of the destination.

Folding changes only the view. It does not change text, task values, saves or
history. Reader state is memory-only and resets when its document/surface is
remounted, including a mode switch, rename, close or Diary lock. Editor folding
uses the existing Monaco view-state lifecycle independently of Reader state.
PDF and HTML exports use separate, fully expanded render surfaces; Markdown
export remains the original source.

Boundaries: no extra disclosure is added to native Details or to Flex itself;
Code Group keeps its tabs and individual code panels can fold. Sections inside
a container stop at that container's boundary. A one-line item with no child
content has no item disclosure. Monaco can represent only one fold at any
start line, so an enclosing list/quote takes precedence over a first item or
heading starting on that same line. Documents at or above 500,000 characters
retain the large-document protection and do not receive structural folding.

## Callouts

Nuvyn supports five GitHub-style Alerts. A canonical marker at the start of a
blockquote turns that blockquote into a lightweight, typed Alert while the
content inside continues to use normal Markdown.

```md
> [!NOTE]
> This is a note.
```

The supported markers are exactly `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and
`CAUTION`. Markers are case-sensitive and must occupy the first line of the
blockquote by themselves. Alerts display only their body, without a generated
type title or empty title row. They use the same thin left-border treatment as
ordinary quotes, with a soft type-colored background and border. This applies
to reading mode, light/dark themes, and PDF export. Ordinary quotes use the
same compact font size, line height, and padding as Alerts while retaining
their own colors. Heights remain content-driven; colon-fenced containers
remain borderless pastel cards.

For example:

```md
> [!WARNING]
> Back up your data first.
```

Custom titles are not supported, and folded Alerts (`+` / `-` markers) are not
enabled. Legacy, unknown, lowercase, titled, and folded forms remain ordinary
blockquotes; Nuvyn does not silently convert them to canonical Alerts.

## Custom containers

Use `info`, `tip`, `warning`, `danger`, or `details` with a colon fence.
Containers show a title only when you explicitly supply an alias after the
type. Without an alias, only the body is displayed, with no default type
label or empty title row:

```md
::: info
This container has no title.
:::

::: warning Back up first
This container displays the title "Back up first".
:::
```

Aliases support safe inline Markdown, such as `::: tip **Useful** advice`.
A `details` container needs an alias for its clickable disclosure title:
`::: details Read more` starts closed, while `::: details Read more {open}`
starts open. Without an alias, `details` displays its body directly as a
non-collapsible card, including when only `{open}` is supplied. PDF export
retains explicit aliases and expands named details without changing the reader.
Expanded, named `details` show a faint separator below their title in reading
mode and PDF export. The separator disappears when collapsed and is not added
to untitled containers or other container types.

Only these colon-fenced containers support aliases. GitHub-style Alerts above
always display only their body; Flex layout syntax is unchanged.

## Inline table of contents

Nuvyn does not provide an inline `[[toc]]` Markdown extension. The document's
right-side heading navigation remains available, but no table of contents is
inserted into the Markdown body.

`[[toc]]`, `[[TOC]]`, and `[[Toc]]` all use the normal WikiLink resolver, just
like any other WikiLink. Existing notes that relied on the removed inline
extension should be reviewed manually. See the
[post-MD-EXT compatibility note](../migrations/markdown-post-md-ext-compatibility.md)
for the migration contract.

## Mathematics

Nuvyn renders math with KaTeX. Use single dollar delimiters for an inline
formula:

```md
Euler's identity is $e^{i\pi}+1=0$.
```

Use a `$$` block for a display formula:

```md
$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
```

Inline formulas stay on one line. Dollars in code spans/fences and escaped
dollars such as `\$100` remain literal text. KaTeX supports a high-performance
subset of LaTeX math syntax; this build does not provide MathJax, equation
numbering, or user-defined global macros.

## Links Between Notes

Use Wiki links or relative Markdown links:

```md
[[inbox/example]]
[[inbox/example|Readable label]]
[[inbox/example#heading]]
[Readable label](../inbox/example.md)
```

Known targets navigate inside the vault. Missing Wiki targets are styled as missing. Links inside inline or fenced code are not indexed.

When renaming a file or folder, Nuvyn can update incoming Wiki and Markdown references. The Links panel shows both outgoing links and backlinks for the current note.

## Diagrams

### Arrange Markdown with Flex

Use the single `flex` container for image rows and other block layouts. Each
direct Markdown block automatically becomes one Flex item, so two images only
need blank-line separation:

```md
::: flex

![Architecture A](@/attachments/images/a.png)

![Architecture B](@/attachments/images/b.svg)

:::
```

This also works for paragraphs, headings, lists, code blocks, tables, callouts,
Mermaid, and other supported Markdown blocks. A soft line break stays in its
paragraph; use a blank line when two blocks should be separate Flex items.
Images remain normal Markdown resources and keep their existing authentication,
Include, and Attachment Manager reference behavior.

To group several blocks into one item, nest another `flex` container. The
nested container's `grow`, `shrink`, `basis`, `self`, and `order` options size
it as an item in its parent, while its other options arrange its own children:

```md
:::: flex direction=row gap=16

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

Container options and defaults:

| Option | Allowed values | Default |
| --- | --- | --- |
| `direction` | `row`, `row-reverse`, `column`, `column-reverse` | `row` |
| `wrap` | `nowrap`, `wrap`, `wrap-reverse` | `wrap` |
| `justify` | `normal`, `start`, `end`, `flex-start`, `flex-end`, `center`, `left`, `right`, `stretch`, `space-between`, `space-around`, `space-evenly`, and safe/unsafe position variants | `flex-start` |
| `items` | `normal`, `stretch`, baseline variants, start/end/self-start/self-end, flex-start/flex-end/center, and safe/unsafe position variants | `stretch` |
| `content` | `normal`, `stretch`, baseline variants, start/end/flex-start/flex-end/center, space-between/around/evenly, and safe/unsafe position variants | `stretch` |
| `gap` | `0`, `4`, `8`, `12`, `16`, `24`, `32` pixels | `16` |
| `mobile` | `stack`, `preserve` | `stack` |
| `grow` | integer `0`–`4` | `0` |
| `shrink` | integer `0`–`4` | `1` |
| `basis` | `auto`, `0`, `25%`, `33.33%`, `50%`, `66.67%`, `75%`, `100%` | `auto` |
| `self` | `auto`, `stretch`, start/end/self-start/self-end, flex-start/flex-end/center, `baseline`, and safe/unsafe position variants | `auto` |
| `order` | integer `-3`–`3` | `0` |

Multi-word CSS alignment values use hyphens in the Markdown parameter, such as
`items=first-baseline` or `justify=safe-center`. `content=start` uses the
standard CSS `start` value. Arbitrary CSS, inline styles, expressions, URLs,
`calc()`, and `var()` are not accepted.

On narrow Note reading areas, horizontal layouts stack by default. Set
`mobile=preserve` to retain the authored direction; overflow remains contained
within the layout. This breakpoint follows the available article width rather
than the device viewport. Nested Flex is supported at multiple levels; use
longer colon fences for nested containers when it improves readability.

Reverse directions and `order` change visual placement, not DOM or screen-reader
reading order. PDF export applies a separate printable layout. Flex markup is
rendered in Reader, Print/PDF, and other Markdown preview surfaces; edit its
source directly in Monaco. Invalid or incomplete syntax remains ordinary
Markdown.

The former `image-row` syntax was removed after confirming it does not occur in
the repository's default `src/content` vault Markdown. Existing image
references there now use the same `flex` container as every other layout. See the
[Flex Container design note](../design/note-flex-container-prd.md) for parser,
security, responsive, PDF, and reference-index details.

### Embed a Board

Draw a diagram in **Board**, then choose **Copy Note reference** in the Board
editor's menu. Paste the copied Markdown on its own line in a Note:

```md
![System diagram](board:8a1c2544-dad0-4f20-a593-7bbc59882921)
```

Reading and preview modes display a crisp SVG image of the saved Board. Click
the image to return to the Board editor. The reference uses a
stable Board ID, so renaming the Board does not break it; the image's alternative
text uses its current title. Saving a Board updates the embed when you return to the
Note. Visible Notes also check for changes every 15 seconds while the browser
tab is active. Only the saved server version is shown, not recovery drafts.

Deleted Boards show a clear missing-reference message. Network/rendering
failures offer **Reload**. Embeds use the existing authenticated Board/Asset
APIs and do not change the Board's last-opened time. They require Nuvyn to
render; use PNG/SVG export when sharing a static diagram outside Nuvyn.

### Reuse an image from Attachment Manager

Open **Settings → Storage & attachments** to inspect and preview supported
images. The manager's upload action adds an image to the Note image library;
it does not accept arbitrary files. In a Note, choose **Insert image** and then
select a Vault image to insert its existing reference, or a Board image to
import a validated copy into the Note library. In Board, open the editor menu
and choose **Insert image from attachments**: a Board image keeps its Asset
identity, while a Vault image is imported as a new Board Asset. These actions
use the existing Note and Board save/recovery flows. Diary content is excluded.

The manager's cleanup check is advisory only; it does not delete or quarantine
resources. A missing current reference is not proof that a file is safe to
remove.

### Mermaid and Markmap

Use a `mermaid` fence for diagrams and a `markmap` fence for an interactive outline map:

````md
```mermaid
flowchart LR
  Draft --> Review --> Archive
```

```markmap
# Topic
## Branch
- Detail
```
````

Mermaid runs with `securityLevel: 'strict'`. Both diagram types are mounted only after the sanitized Markdown render completes.

## HTML Safety

Semantic HTML is enabled for compatibility, but the final rendered HTML passes through a DOMPurify allowlist before Vue inserts it. Scripts, event handlers, styles, iframes, embedded objects, SVG, forms, and unsafe URLs are removed. AI chat Markdown is stricter and disables raw HTML entirely.

For the full boundary, see [Deployment Security](../deployment/security.md).
