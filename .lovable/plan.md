## Goal

Fix the above-the-fold experience on mobile (≤414px) so the hero feels tight, scannable, and the mock visual is reachable without heavy scrolling. Apply consistent mobile spacing across the rest of the homepage as a follow-up pass.

## Problems on mobile today

- `h1` jumps to `text-5xl` (48px) on phones — Dutch headline wraps awkwardly and pushes the mock far below the fold.
- Section padding `pt-16 pb-20` is too large on small screens.
- Trust badges + 5-star "Loved by coaches" row stack into 4 separate lines, eating vertical space before the mock is visible.
- Mock window sits below a tall copy block; on a 390×844 device the user sees almost no product visual without scrolling.
- Mock browser bar URL (`padeltrainer.ai/rene`) and slot row sub-labels can clip on narrow widths.
- Tabs row inside the mock (`Booking / Players / Payments / Profile`) overflows horizontally.
- Floating chips are hidden on mobile (correct), but the mock keeps the same paddings as desktop.
- Other sections (`HowItWorks`, `JobsToBeDone`, `Pricing`, `FAQ`, `FinalCTA`) use `py-24 md:py-32` — 96px top/bottom on mobile is too much.

## Changes

### 1. HeroSection (`src/components/home/HeroSection.tsx`)

- Reduce hero vertical padding: `pt-10 pb-12 md:pt-16 md:pb-20 lg:pt-24 lg:pb-28`.
- Scale the headline: `text-[34px] leading-[1.05] sm:text-5xl lg:text-7xl`.
- Subheadline: `text-base sm:text-lg md:text-xl`, tighter top margin (`mt-4 md:mt-6`).
- CTA row: full-width primary on mobile (`w-full sm:w-auto`), keep ghost link inline below.
- Collapse trust + star row into a single horizontal strip on mobile (smaller text, `gap-x-3 gap-y-1`, hide "across Europe" tail on `<sm`).
- Reorder grid on mobile so the mock window appears directly under the headline + CTA (use `order-2 lg:order-none` on the copy block? — actually keep copy first but trim it, then mock).
- Tighten grid gap: `gap-8 lg:gap-12`.

### 2. Hero mock window

- Outer padding inside `.mock-window` stays, but slot row padding becomes `p-2.5 md:p-3` and font `text-[13px]`.
- Tabs row: add `overflow-x-auto no-scrollbar` and shrink to `text-[11px]`, drop the "Profile" tab on `<sm`.
- URL in browser bar: truncate with `truncate max-w-[55%]` so it never pushes the dots.
- Slot sub-line: hide court suffix on `<sm` (`hidden sm:inline`) to prevent wrapping.

### 3. Global mobile spacing pass

- Across `HowItWorksSection`, `JobsToBeDoneSection`, `PainStoriesSection`, `SolutionOverview`, `PricingPreview`, `FAQSection`, `FinalCTASection`: change `py-24 md:py-32` → `py-16 md:py-24 lg:py-32`.
- Section eyebrow + heading: `text-3xl sm:text-4xl md:text-5xl` where currently `text-4xl md:text-5xl` to avoid clipping on 320–375px.
- Card grids already responsive; just verify `gap-6` reduces to `gap-4` on mobile where stacked.

### 4. HowItWorks mock visuals (already added)

- Calendar mock: 5 columns × text becomes cramped at 390px → switch to horizontal scroll on `<md` (`overflow-x-auto`, `min-w-[520px]` inner) so the visual stays legible instead of squishing.
- Availability heatmap: reduce inner padding to `p-4` on mobile and tile gap to `gap-1.5`.
- Booking page mock: keep, but shrink avatar + slot pills to `text-[11px]` so they stay on one line.

## Out of scope

- No copy / i18n changes.
- No new sections, no business-logic changes.
- No changes to navbar / footer / banner — those already work on mobile.

## Verification

- Resize preview to 390×844 and 360×800.
- Confirm: headline + subheadline + primary CTA + first glimpse of mock visible without scrolling on 390×844.
- Confirm no horizontal scrollbar on `<html>`.
- Confirm calendar mock scrolls horizontally cleanly (no overlap).
