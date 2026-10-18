# Markdown Post-MD-EXT Compatibility Changes

This note records two intentional Markdown compatibility changes made after the
VitePress-style Markdown Extensions program was closed. They are maintenance
decisions, not a new Markdown extension phase.

## GitHub-style Alerts

Nuvyn now recognizes only the five exact, uppercase GitHub-style Alert markers:

```md
> [!NOTE]
> text

> [!WARNING]
> text
```

As of 2026-10-17, Alerts render as body-only cards without generated titles.
The five markers still select their existing type colors in reading mode and
PDF export. This presentation change does not rewrite stored Markdown.

The 2026-10-18 presentation update gives Alerts a thin type-colored left border
and softer background, following their blockquote syntax. Generated titles
remain hidden, while ordinary quotes and colon-fenced containers are unchanged.

The marker is case-sensitive and must be the only content on the first
blockquote line. Custom titles and folded `+` / `-` forms are not supported.

Before, legacy Obsidian-style forms could appear in existing notes:

```md
> [!note]
> text

> [!warning] Database migration
> text
```

After, those forms remain ordinary blockquotes. They are not silently migrated
or converted to an Alert. Nuvyn intentionally does not restore the older
Obsidian aliases or provide an automatic rewriting tool.

## Inline TOC removal

The body-level `[[toc]]` extension has been removed.

Before, this syntax generated an inline table of contents:

```md
[[toc]]
```

Now, `[[toc]]`, `[[TOC]]`, and `[[Toc]]` are ordinary WikiLinks and are passed
to the normal WikiLink resolver. They no longer generate `nav.nuvyn-toc` or
any other inline navigation element. Existing notes that depended on the old
inline TOC need manual review; the right-side document heading navigation is
the supported navigation surface.

## Compatibility policy

These are deliberate post-MD-EXT maintenance decisions. They are not MD-EXT-8,
and they do not rewrite the historical MD-EXT specifications or release-gate
evidence. Historical documents describe the behavior and baseline that were
reviewed at the time; this note describes the current compatibility contract.
