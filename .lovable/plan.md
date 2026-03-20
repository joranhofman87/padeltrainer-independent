

# Build: Padel Racket Finder Quiz

## Overview
An interactive 5-6 question quiz at `/:lang/racket-finder` that matches users to recommended rackets from Sanity CMS. Premium UI with animated transitions, progress bar, shareable results, and full PostHog tracking.

## Files to Create/Modify

### 1. New page: `src/pages/marketing/RacketFinder.tsx`
Main quiz page with three states: intro, quiz, results.
- Intro: SEO-friendly text block + "Start Quiz" CTA
- Quiz: Single question per screen with large option buttons (emoji + label), progress bar, slide animations via framer-motion
- Results: 1-3 racket cards with badges, affiliate/review links, share buttons, retake option
- Reads query params on mount to restore shared results
- Uses `MarketingLayout` wrapper like other marketing pages
- SEO component with Quiz structured data

### 2. New component: `src/components/racketfinder/QuizQuestion.tsx`
Reusable animated question component with option buttons. Handles slide-left/right transitions via `AnimatePresence`.

### 3. New component: `src/components/racketfinder/QuizResults.tsx`
Results display: racket cards with badges (#1 Pick, Great Alternative, Budget-Friendly), specs grid, affiliate/review buttons, share buttons (WhatsApp, X, copy link), retake button.

### 4. New hook: `src/hooks/useRacketFinderQuery.ts`
Handles the GROQ query logic:
- Maps quiz answers to filter params (levels array, styles array, maxPrice, armFriendly, weight, shape)
- Fetches from Sanity with progressive relaxation (drop weight filter, then shape filter) if < 2 results
- Beginner auto-sets style to "control" and skips Q2

### 5. i18n translations (5 files)
Add quiz keys to `marketing.json` for each language (en, nl, es, de, fr) with all the translations provided.

### 6. Route registration: `src/components/DomainRouter.tsx`
Add lazy import for `RacketFinder` and route `<Route path="racket-finder" element={<RacketFinder />} />` inside the `/:lang` marketing routes.

### 7. PostHog tracking
Fire events via existing `src/lib/posthog.ts` utilities:
- `quiz_started`, `quiz_step_completed`, `quiz_completed`, `quiz_result_click`, `quiz_shared`, `quiz_retake`

## Technical Details

### Sanity GROQ Query
The `product` schema already has all required fields: `category`, `level`, `playingStyle`, `shape`, `weight`, `armFriendly`, `priceMidpoint`, `priceRange`, `affiliateUrl`, `shortDescription`, `specs`, `brand`, `name`, `slug`, `language`.

Query filters `_type == "product" && category == "racket" && language == $lang` plus dynamic filters based on answers. Level mapping: beginner -> `["beginner", "all"]`, intermediate -> `["intermediate", "beginner", "all"]`, advanced -> `["advanced", "intermediate", "all"]`. Style always includes `"allround"` alongside selection.

### Quiz State Machine
- Steps stored in state array; current step index tracked
- Beginner skips Q2 (playing style auto-set to "control")
- On final answer, build query params, update URL for shareability, fetch results
- Back button decrements step (skipping Q2 for beginners)

### Shareable URLs
Results encoded as query params: `?level=intermediate&style=control&budget=150&arm=true&weight=medium&shape=any`
On page load, if params present, skip to results view immediately.

### Design
- Progress bar using existing `Progress` component
- `framer-motion` `AnimatePresence` for slide transitions between questions
- Large touch-friendly buttons (min 48x48px) with emoji icons as specified
- Mobile-first responsive layout
- Dark green/white/orange accent color palette matching existing brand

### SEO
- `<SEO>` component with quiz-specific title/description per language
- FAQPage structured data covering common racket selection questions
- Intro text block rendered above quiz for indexing

