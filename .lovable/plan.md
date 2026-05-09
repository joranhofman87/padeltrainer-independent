## Problem

On mobile the page allows horizontal scrolling, which shifts the layout left and breaks the "above the fold" experience (visible in the uploaded screenshot — wordmark and CTA spill off the right edge).

## Root cause

There is no global `overflow-x: hidden` on `html` / `body`. A handful of intentionally-wide children (the calendar mock uses `min-w-[480px]` inside an `overflow-x-auto` wrapper, the marquee uses `width: max-content`, and the dot-grid `absolute inset-0` paired with `mask-image`) can leak when something pushes them past the viewport — e.g. iOS Safari momentum-scroll, a very long Dutch word, or the dot-grid mask. With no body-level guard, the whole document gets scrollable.

## Fix

### 1. Lock horizontal scroll at the root

In `src/index.css`, add to the global layer:

```css
html, body {
  overflow-x: hidden;
  max-width: 100vw;
}
```

This is the standard guard for mobile marketing pages and has no side-effect on vertical scroll, sticky headers, or modals (we already use full-page routes per the design rules, no `position: fixed` overlays depend on document-level horizontal scroll).

### 2. Belt-and-braces on the hero section

`src/components/home/HeroSection.tsx` — the section already has `overflow-hidden`, but the inner grid container does not. Add `overflow-hidden` (or `min-w-0` on the copy column) so the long Dutch h1 (`Wij regelen de rest.`) cannot push the grid wider than the viewport.

### 3. Verify the calendar mock wrapper

`src/components/home/HowItWorksSection.tsx` — the `min-w-[480px]` inner grid lives inside `overflow-x-auto no-scrollbar`. Confirm the parent `<div className="card-chip">` of that wrapper has `overflow-hidden` so the rounded corners clip the scroller (not strictly required for the bug, but tidies the visual at the edges).

## Verification

- Resize preview to 360×800 and 390×844.
- Confirm: no horizontal scrollbar appears, swiping right does nothing, hero h1 + CTA stay flush to the left edge.
- Confirm: calendar mock still scrolls horizontally inside its own container only.

## Out of scope

- No copy or token changes.
- No restructuring of mocks.
