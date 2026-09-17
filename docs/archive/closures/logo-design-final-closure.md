# Nuvyn Logo Design Final Closure

**Status:** Closed / Design baseline

**Date:** 2026-08-03

## 1. Decision

The Nuvyn logo and the expanded brand constellation animation are formally
closed as the current visual baseline. Future changes should be limited to
implementation fixes, accessibility improvements, or a new design review.

The design combines a practical knowledge tool with an inward practice of
attention and understanding. Its guiding line is:

> 灵根育孕源流出，心性修持大道生。

In Nuvyn terms:

> 九流汇于中宫，心性定而大道生。

## 2. Visual composition

### Core mark

The core symbol is an abstract seated figure formed from flame- and
lotus-like curves. It can be read as a person in meditation: centered,
attentive, and aware while knowledge flows around them.

The symbol intentionally remains abstract rather than depicting a literal
brain, person, or religious figure. This keeps the meaning open while making
the idea of **定中宫** visible: the center stays calm even when the outside
world is active.

### Knowledge constellation

The expanded animation contains one central circle and nine surrounding
nodes. The central circle is the stable knowledge and awareness center; the
nine nodes represent ideas, notes, reading, practice, and AI-assisted
discovery arriving from different directions.

Nine is used deliberately. In traditional Chinese culture, nine is often
regarded as the highest single digit and is associated with completeness and
culmination. The nine links turn isolated inputs into a connected knowledge
network.

### Flow

Dashed radial links and moving particles show information being gathered into
the center. The flow is not intended to suggest passive storage: information
must pass through attention, judgment, and practice before it becomes durable
knowledge.

## 3. Motion rules

- The constellation opens after the pointer remains over the brand area for
  three seconds.
- Nine nodes appear in sequence with a 140 ms stagger between nodes.
- Particles travel from the nodes toward the center continuously.
- The central symbol does not pulse or scale. The center is intentionally
  stable, reinforcing **定中宫**.
- The pointer is hidden while the full constellation is visible and returns
  when the animation closes or the pointer leaves the brand area.
- The animation is disabled or simplified under `prefers-reduced-motion`.

## 4. Theme behavior

The symbol uses theme-aware contrast:

- Light theme: black line art on a light central surface.
- Dark theme: white line art on a dark central surface.

The geometry, node count, and meaning do not change with the theme. Only the
contrast treatment changes so the mark remains legible in both modes.

## 5. Implementation baseline

| Area | Location | Responsibility |
|------|----------|----------------|
| Core SVG asset | `public/brain.svg` | Central abstract seated figure |
| Brand trigger and SVG layout | `src/components/NavBar.vue` | Hover delay, nine nodes, particle paths, home action |
| Visual styling | `src/style.css` | Theme contrast, motion, backdrop, cursor behavior |
| Design explanation | `README.md`, `README.zh-CN.md` | Public design rationale |

The brand area uses a button for the home action rather than a navigational
anchor. This avoids exposing the local development URL in the browser status
area while preserving the click-to-home behavior.

## 6. Non-goals after closure

The following are not part of routine polish work:

- replacing the seated central figure with another metaphor;
- changing the constellation from nine nodes;
- reintroducing stage-based scholar / practitioner / king transitions;
- adding scale pulsing to the central figure;
- changing the animation into a separate onboarding or loading screen;
- changing the design language solely to follow a temporary color trend.

Any of these changes requires a new design proposal and review against the
meaning of **定中宫** and the Nuvyn knowledge-flow model.

## 7. Verification

- `git diff --check` passes for the closure changes.
- The SVG asset remains valid and is loaded through the existing brand
  constellation path.
- Client type checking currently reports an unrelated pre-existing test type
  mismatch in `src/components/vault/__tests__/RightRail.test.ts:53`
  (`Type '1' is not assignable to type '2 | 3 | 4'`). This is not caused by
  the Logo implementation.

## 8. Final statement

Nuvyn is represented as a tool that helps knowledge move, and a practice that
helps the person receiving that knowledge remain centered. The nine streams
converge without disturbing the center; from that centered understanding, a
larger path can emerge.
