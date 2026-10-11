# Logo and Brand Motion

This page describes the brand assets and interaction currently shipped by Nuvyn. The dated design-closure record is preserved in the [documentation archive](../archive/closures/logo-design-final-closure.md).

## Current mark

The primary mark is a gradient knowledge crest with concentric circles and connected nodes. It is paired with the `Nuvyn` wordmark in the navigation bar.

| Asset | Current use |
| --- | --- |
| `public/logo-48.png` | 24 px navigation mark and browser icon |
| `public/logo.svg` | scalable primary crest for documentation and other surfaces |
| `public/favicon.svg` | scalable crest variant retained as a public asset |
| `public/brain.svg` | retained legacy public asset; not used by the current constellation |

`index.html` currently selects `logo-48.png` as the favicon. Keep SVG and raster variants visually aligned when the primary mark changes.

## Expanded constellation

Hovering over the navigation brand for three seconds opens a non-interactive full-screen constellation on desktop. On phones and tablets, a three-second long press on the same Logo area starts the same animation; ordinary taps still navigate home. Touch movement beyond 12 px, lifting before the threshold, or `pointercancel` cancels a pending long press. Once recognized, lifting does not interrupt the animation, and the Logo consumes its generated click so it cannot accidentally navigate home.

The finite decorative transition uses a near-black field, a thin central circle, and one faint point. It has no network, surrounding nodes, permanent links, or looping particles. It contains no character or meditation image. On a Vault document eligible for Zen Mode, the Logo opens a quieter Nine Virtues journey instead of the simultaneous nine-node network. Its fixed order is Courage, Honesty, Reflection, Humility, Kindness, Patience, Restraint, Focus, and Clarity. Every word always has a large Chinese main label and a smaller English subtitle, independent of app locale; both lines transition together. Neither a title nor progress numbers are shown. The nine positions progress through the existing blue-violet scale from `#6270AC` to `#C4C1FA`. Courage begins and Clarity completes the virtues, with Reflection third. Oneness (归一) is the closing state formed by their integration, not a tenth virtue or particle.

The journey opens on a near-black field for 300 ms. Courage's single point fades in for 400 ms, then travels toward the center for 900 ms. During the final 300 ms of that travel, the central circle starts forming; the bilingual word appears only when the point arrives. The circle finishes growing over another 600 ms, then rests for 700 ms. Each later round shows one new point for 250 ms, moves it toward the circle's visible edge for 850 ms, dissolves it over a 200 ms response, and holds the new word for 600 ms. A faint path exists only for the current flight; there are no permanent links or surrounding nodes. Only the central circle grows: a particle never inherits a scaling coordinate system.

A finite particle's `endEvent` advances its round and reveals its bilingual word. A duration-bounded watchdog recovers missing events without launching overlapping rounds. The persistent circle responds gently to each arrival; its edge accumulates nine colored segments. Clarity has no pulse and holds for 1200 ms. The segments then blend into a pale violet ring over 600 ms with a subtle contraction of the circle only. Clarity transitions to 归一 / Oneness as one bilingual group (120 ms out, 180 ms in); Oneness holds for 1500 ms after appearing, followed by a 500 ms fade. No tenth particle appears. The complete normal journey lasts about 21.6 seconds after the Logo gesture. Zen Mode starts only after that fade and VaultView's final eligibility check. On ineligible pages, both desktop and touch decoration show a 300 ms black field, fade in the simple center over 400 ms, hold for 1200 ms, then close automatically without entering Zen Mode. Under reduced motion, or when finite SVG motion is unavailable, a stationary circle presents Courage, Clarity, then Oneness before the same safe exit; reduced motion starts with the same short black field and skips the moving and blending transitions.

Each current point carries two low-opacity, locally blurred SVG halos. They share its finite motion transform: glow gently increases during flight, then the entire point-and-halo group dissolves over 200 ms on arrival. The center has a faint edge glow, becoming slightly more complete at Oneness without a flash. Only one moving group and two small filters are active; no glow is applied to the text. Reduced motion disables the halo animation as well. The visual intent is quiet, continuous micro-light, not neon or a game-like reward.

Leaving a desktop hover, pressing Escape, changing route, hiding the document, or blurring the window closes a pending constellation and restores the pointer. Touch recognition is scoped to the Logo: normal document scrolling and the rest of the navigation remain unaffected.

The animation is decorative and `aria-hidden`. The brand button itself has an accessible home label and navigates to the application root.

## Theme and motion

The crest uses its own purple-blue gradient. The decorative geometric center mark uses the active theme's accent tokens. The Nine Virtues journey uses the same near-black field in both themes. Under `prefers-reduced-motion: reduce`, movement, decorative orbit and node animations, and entry/exit transitions are disabled. The simplified Courage-to-Clarity journey never waits for animation events.

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

