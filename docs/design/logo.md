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

Hovering over the navigation brand for three seconds opens a non-interactive full-screen constellation on desktop. On phones and tablets, a three-second long press on the same Logo area starts the same animation; ordinary taps still navigate home. Touch movement beyond 12 px, lifting before the threshold, or `pointercancel` cancels a pending long press. Once recognized, lifting does not interrupt the animation, and the Logo consumes its generated click so it cannot accidentally navigate home.

On a Vault document eligible for Zen Mode, the constellation becomes the Nine Virtues sequence. Its fixed order is Courage, Honesty, Reflection, Humility, Kindness, Patience, Restraint, Focus, and Clarity. Chinese and English labels follow the active app locale; the title “Nine Virtues” is never shown. The nine positions progress through a restrained blue-violet scale from `#6270AC` to `#C4C1FA`; each node and its particle share that position's color. The final ordering puts Courage at the beginning and Clarity at the end, with Reflection third, as a narrative arc from facing reality to seeing clearly—not a claim that people must cultivate the virtues in a prescribed order.

After the constellation opens, one finite SVG motion particle launches from each node every 600 ms; each 540 ms motion eases toward the visible edge of the central core, with a short gap before the next launch. Its virtue label begins its gentle cross-fade on that same launch beat, so the first particle and Courage appear together. A particle's actual `endEvent` (or its duration-bounded recovery watchdog) marks arrival; it does not change the label. Only after Clarity's particle arrives does its 800 ms hold begin, then the constellation fades out. Infinite orbit and line animations never advance the sequence or determine completion. Zen Mode starts only after the leave transition and VaultView's final eligibility check. On ineligible pages, desktop decoration stays until pointer leave while a touch-triggered constellation fades out after the animation; reduced-motion mode skips particle travel and briefly presents Clarity before the same safe exit.

Leaving a desktop hover, pressing Escape, changing route, hiding the document, or blurring the window closes a pending constellation and restores the pointer. Touch recognition is scoped to the Logo: normal document scrolling and the rest of the navigation remain unaffected.

The animation is decorative and `aria-hidden`. The brand button itself has an accessible home label and navigates to the application root.

## Theme and motion

The crest uses its own purple-blue gradient. The expanded center symbol is inverted in dark mode. Under `prefers-reduced-motion: reduce`, orbit, link, center, and node entrance animations and entry transitions are disabled; nodes remain visible and an eligible Logo constellation does not wait for an animation event before entering Zen Mode.

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

