## Goal

Replace the generic Lucide-icon tiles and flat visuals on the remaining marketing pages with the same Tailwind-built mini illustrations and mock-window style used on the new homepage (`HeroSection`, `SolutionOverview`, `HowItWorksSection`, `JobsToBeDoneSection`). No copy, no data, no routes — purely a visual upgrade.

## Visual vocabulary to reuse (from homepage)

- **Mini illustrations**: small Tailwind compositions like `MiniCalendarGrid`, `MiniChecklist`, `MiniPhoneBooking`, `MiniShield` in `SolutionOverview.tsx` (rounded chips, brand/muted swatches, no raster art).
- **Mock window** chrome (card with traffic-light dots and a faux toolbar) used in the hero.
- **Brand-tinted icon tile** with `bg-brand-500 text-white` for featured / `bg-brand-50 text-brand-600` default (already wrapped in `IconTile`).
- **`card-chip`** surface + `dot-grid` backdrops + `eyebrow` pill + `pill-primary` / `pill-ghost` CTAs.
- **`section-cream`** alternating with white for vertical rhythm.

## Step 1 — Extract a small illustration kit

Create `src/components/marketing/visuals/` with reusable, theme-token-only SVG/Tailwind primitives so any page can drop them in:

- `MockWindow.tsx` (already partially in `sections/`, promote and standardise: traffic-light dots, header bar, `card-chip` body, optional caption).
- `MiniCalendarGrid.tsx`, `MiniChecklist.tsx`, `MiniPhoneBooking.tsx`, `MiniShield.tsx` (lifted from `SolutionOverview` and exported).
- New small ones to cover other pages' topics (still pure Tailwind/SVG, no new deps):
  - `MiniBarChart` — pricing / analytics tiles.
  - `MiniRacketSwatch` — racket finder / listings empty-state and topic tiles.
  - `MiniCourtDiagram` — strokes, rules, level test.
  - `MiniVideoFrame` — video tips listing/tiles.
  - `MiniArticleCard` — blog/learn/topic tiles.
  - `MiniQuizDots` — quiz/level-test/red-flag.
  - `MiniMapPin` — city landing, coach pages.
- Single `index.ts` barrel, all using `text-brand-*`, `bg-muted`, `text-navy-*` tokens — no hard-coded colors.

These are presentation-only, framework-free, < 80 lines each.

## Step 2 — Page-by-page visual swap

Same pattern on every page: keep markup/data/i18n; replace the current `lucide` icon-in-circle blocks or stock visuals with the new primitives wrapped in `IconTile` / `MockWindow`, and ensure section backgrounds alternate `section-cream` ↔ white.

**Tier A — Pillars / high-traffic**
- `Pricing.tsx` — swap plan-feature icons for `IconTile` + `MiniBarChart` hero visual; reuse `MarketingFinalCTA`.
- `About.tsx` — replace big emoji/icon header with `MockWindow` showing a faux dashboard; values grid uses `IconTile`.
- `Coaches.tsx` + `CoachPage.tsx` — coach card avatars get the homepage chip frame; empty/hero gets `MiniMapPin` mock window.
- `LearnIndex.tsx` / `TopicsIndex.tsx` / `TopicPage.tsx` / `LearningArticlePage.tsx` / `BlogPost.tsx` — article tiles use `MiniArticleCard`; hero uses `MockWindow` with mini article preview.

**Tier B — Tools / playground**
- `Playground.tsx` — tool tiles get `IconTile` + matching `Mini*` (e.g. `RacketFinder` → `MiniRacketSwatch`, `RateMyCourt` → `MiniCourtDiagram`, `RedFlagQuiz` → `MiniQuizDots`).
- `RacketFinder.tsx`, `RacketListing.tsx`, `RacketDetail.tsx` — hero/empty states use `MiniRacketSwatch` inside a `MockWindow`; filter chips already updated.
- `PadelLevelTest.tsx`, `RedFlagQuiz.tsx`, `ChallengeModePage.tsx` — quiz intro hero with `MiniQuizDots`; result cards reuse `card-chip`.
- `Strokes.tsx` / `StrokePage.tsx`, `Rules.tsx` / `RulesPage.tsx` — illustrate with `MiniCourtDiagram`.
- `VideoTips.tsx` / `VideoTipPage.tsx` — thumbnails framed in `MiniVideoFrame` / `MockWindow`.
- `RateMyCourtPage.tsx` — `MiniCourtDiagram` + score bars made of `MiniBarChart`.

**Tier C — Supporting**
- `Partner.tsx`, `PressKit.tsx`, `FoundingTrainers.tsx`, `CityLanding.tsx`, `PublicRatingCard.tsx`, `Privacy.tsx`, `Terms.tsx` — heroes use `MarketingHero`, supporting visuals swapped to `IconTile` + appropriate `Mini*`. Legal pages keep prose, only hero gets the new chrome.

## Step 3 — Audit & QA

- Grep for ad-hoc `bg-gradient-to-*`, hex colors, `text-white`/`bg-black`, and inline color styles on the listed pages; replace with tokens.
- Verify dark mode and `1267px` desktop + 375px mobile for every changed page.
- Confirm no functional/route/i18n key change vs. `git diff`.
- Lighthouse-style sanity: no new images shipped (all SVG/Tailwind), no new deps.

## Guardrails

- Frontend/presentation only. No DB, edge functions, RLS, schema, copy, SEO metadata, routes.
- Only tokens from `src/index.css` + `tailwind.config.ts`. No new colors. No em-dashes.
- No new animation/illustration libraries. Reuse `framer-motion` only if already imported on a page.
- Keep existing props, data fetching, translation keys, analytics events untouched.

## Out of scope

Detail pages where the visual already comes from CMS imagery (`BlogPost` body, `LearningArticlePage` body, `CoachPage` profile photo) — only their hero/cards get the new chrome; user-supplied media stays as-is.

## Rollout

1. Land Step 1 (visual kit) + retrofit `SolutionOverview` to import from it (no homepage diff).
2. Ship Tier A as one batch with before/after screenshots.
3. Ship Tier B in one batch.
4. Ship Tier C in one batch.