# Logo and Brand Motion

This page describes the brand assets and interaction currently shipped by Nuvyn. The dated design-closure record is preserved in the [documentation archive](../archive/closures/logo-design-final-closure.md).

## Current mark

The primary mark is a gradient knowledge crest with concentric circles and connected nodes. It is paired with the `Nuvyn` wordmark in the navigation bar.

| Asset | Current use |
| --- | --- |
| `public/logo-48.png` | 24 px navigation mark and browser icon |
| `public/logo.svg` | scalable primary crest for documentation and other surfaces |
| `public/favicon.svg` | scalable crest variant retained as a public asset |
| `public/brain.svg` | central symbol in the expanded brand animation |

`index.html` currently selects `logo-48.png` as the favicon. Keep SVG and raster variants visually aligned when the primary mark changes.

## Expanded constellation

Hovering over the navigation brand for three seconds opens a non-interactive full-screen constellation. Nine outer nodes connect to a centered symbol, with a 140 ms node stagger and inward-moving particles. Leaving the brand, pressing Escape, changing route, hiding the document, or blurring the window closes it and restores the pointer.

The animation is decorative and `aria-hidden`. The brand button itself has an accessible home label and navigates to the application root.

## Theme and motion

The crest uses its own purple-blue gradient. The expanded center symbol is inverted in dark mode. Under `prefers-reduced-motion: reduce`, orbit, link, and center animations and entry transitions are disabled; the nodes remain visible without their entrance animation.

## Change rules

- Preserve the accessible title/description in standalone SVG assets.
- Optimize raster and SVG variants for their actual display sizes.
- Do not put functional UI icons on the brand asset's 1024-unit grid; product icons follow the [Icon System](icon-system.md).
- Update the navigation component, CSS, asset table, screenshots, and browser icon together when changing the mark.
- Treat changes to the nine-node constellation or central metaphor as a brand-design change, not routine icon cleanup.

## Implementation references

- [Navigation interaction](../../src/components/NavBar.vue)
- [Brand styling](../../src/style.css)
- [Primary SVG](../../public/logo.svg)
- [Archived design decision](../archive/closures/logo-design-final-closure.md)

