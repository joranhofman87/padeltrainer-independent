# Marketing visual refresh - rollout plan

Bring every marketing page up to the look and feel of the new homepage. **No database, schema, copy, or business-logic changes** - this is purely a visual / presentation pass using the existing design system (`docs/DESIGN_SYSTEM.md`, tokens in `src/index.css`, primitives in `tailwind.config.ts`).

## Goal

Every marketing surface should feel like it belongs to the same product as the new homepage: confident navy + brand-orange palette, Plus Jakarta display headings, generous spacing, soft cards, dot-grid backdrops, mock windows where useful, and consistent CTA primitives.

## What "homepage look" means (the kit we'll reuse)

Pulled from `src/components/home/*` and `docs/DESIGN_SYSTEM.md`:

- **Eyebrow chip** (`.eyebrow` or the inline navy pill from HeroSection) above every section heading
- **Display headings**: `font-display font-extrabold tracking-[-0.02em]`, responsive scale `text-3xl sm:text-4xl md:text-5xl`
- **Section rhythm**: `py-16 md:py-24 lg:py-32`, alternating `bg-background` / `section-cream` / `section-off`, occasional `bg-navy-950` final CTA
- **Containers**: `max-w-7xl mx-auto px-4 md:px-6`
- **Surfaces**: `.card-chip` for content cards, `.mock-window` + `.mock-bar` for product previews, `.dot-grid` backdrops on hero/CTA
- **CTAs**: `.pill-primary` and `.pill-ghost` only, h-12, with `ArrowRight` icon
- **Trust row**: check-icon list under hero CTAs (`Check` lucide, `text-brand-500`)
- **Icon tiles**: `w-12 h-12 rounded-xl bg-brand-50 text-brand-600`
- **Final CTA**: dark navy section with dot-grid overlay, identical to `FinalCTASection`

## Shared building blocks to extract first (one-time work)

Before touching pages, lift these out of `src/components/home/` into reusable marketing primitives so we don't fork styles:

```
src/components/marketing/sections/
  MarketingHero.tsx        // eyebrow + h1 + sub + CTA row + trust row + optional right-side mock
  MarketingSection.tsx     // wraps children in eyebrow + heading + container + alt bg
  EyebrowChip.tsx
  IconTile.tsx
  MockWindow.tsx           // already implicit in CSS - wrap as a component for reuse
  MarketingFinalCTA.tsx    // generalized FinalCTASection (title / sub / primary CTA props)
  MarketingFAQ.tsx         // generalized FAQSection
```

These are pure presentational wrappers; no logic changes. Existing home sections get refactored to consume them so the homepage stays identical.

## Page-by-page rollout (priority order)

Tier 1 - high-traffic pillar pages (do first):

1. **Pricing** (`Pricing.tsx`) - replace shadcn `Card` plan cards with `.card-chip` styling, add hero with eyebrow + dot-grid, swap buttons for `.pill-primary` / `.pill-ghost`, finish with `MarketingFinalCTA`.
2. **About** (`About.tsx`) - new hero, values grid using `IconTile`, stats row in navy band, final CTA.
3. **Coaches index** (`Coaches.tsx`) + **CoachPage** - hero + filter bar styling, coach cards using `.card-chip`.
4. **LearnIndex** + **TopicsIndex** + **TopicPage** - pillar hub treatment: eyebrow, large display h1, topic cards as `.card-chip` grid, dot-grid hero backdrop.
5. **Blog** + **BlogPost** - hero band, article cards in `.card-chip`, post header with eyebrow + display heading + meta row, sticky TOC styled with navy tokens.

Tier 2 - tools / playground:

6. **Playground**, **RacketFinder**, **RacketListing**, **RacketDetail**, **PadelLevelTest**, **RedFlagQuiz**, **RateMyCourtPage**, **ChallengeModePage** - shared tool-page shell: hero with `.mock-window` style preview where it fits, results screens use `.card-chip`.
7. **Strokes** + **StrokePage**, **VideoTips** + **VideoTipPage**, **Rules** + **RulesPage** - learning-content shell mirroring blog treatment.

Tier 3 - supporting / legal:

8. **Partner**, **PressKit**, **FoundingTrainers** - hero + section rhythm + final CTA.
9. **Privacy**, **Terms** - lighter touch: just hero band + typography pass, keep long-form readable (`prose` width).
10. **CityLanding**, **PublicRatingCard**, **LearningArticlePage** - apply shell, keep dynamic content as-is.

`Brand.tsx` already mirrors the design system - leave as reference.

## Cross-cutting tasks

- **MarketingLayout** (`src/components/marketing/MarketingLayout.tsx`) - audit nav + footer for token consistency (navy text, brand CTA), no structural changes.
- **MegaMenu** - re-skin chips/cards to match `.card-chip` + brand-50 hover.
- **SEO component** - no changes (this is purely visual).
- **i18n** - no copy changes; only restructure markup. If a heading needs to split into eyebrow + h1, reuse existing keys.
- **Dark mode** - verify each refreshed page in dark mode since marketing is light-first; tokens already handle it.
- **Mobile-first QA** at 360 / 414 / 768 / 1280 per design-system rule.

## Guardrails

- No new colors; only tokens from `index.css` / `tailwind.config.ts`.
- No em-dashes in any copy touched.
- Keep all routes, props, data fetching, and translations identical.
- Don't introduce new animation libs; reuse existing `animate-floaty` / framer-motion already in use.
- Keep `staleTime` and query behavior untouched.

## Suggested execution order in build mode

1. Land the shared primitives in `src/components/marketing/sections/` and refactor `Home.tsx` sections to use them (no visual diff on homepage).
2. Ship Tier 1 pages one PR at a time, each with before/after screenshots at mobile + desktop.
3. Ship Tier 2 and Tier 3 in batches grouped by shared shell.

## Out of scope

- Database, edge functions, schema, RLS, content rewrites, SEO metadata changes, new features, new routes.

