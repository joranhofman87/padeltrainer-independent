

# City Page Improvements — 8 Changes

## 1. Fix nearby cities casing
**File**: `src/pages/marketing/CityLanding.tsx` (line ~427)

The `nc.city` value comes from the database as-is (sometimes ALL CAPS like "KAATSHEUVEL"). Apply title-case normalization in the nearby cities strip, same logic as `displayCity` uses.

## 2. Trainers section — show even when empty
**File**: `src/pages/marketing/CityLanding.tsx`

Currently the trainers section is wrapped in `{trainers.length > 0 && ...}` — so it disappears entirely when no trainers exist. Change to always render the section:
- If trainers exist: show the grid (as now) + "View all trainers" link
- If no trainers: show a message like "No trainers available yet in [City]. Are you a padel trainer? Sign up." with a CTA button linking to trainer signup
- Add "View profile" link text on each trainer card

Add new i18n keys: `noTrainersMessage`, `becomeTrainer` across all 5 locales.

## 3. Expand content to 400+ words
**File**: `src/lib/cityContent.ts`

### a) Expand intro templates (~80 → ~150 words)
Add a second paragraph to each language template mentioning:
- Indoor vs outdoor balance for this city
- Proximity to nearby padel cities
- Growth of the padel scene

### b) Add "Which club suits you?" paragraph
Add a new export `generateClubIntro()` that returns ~60 words (all 5 languages) like: "Every club in [City] has its own character. Some focus on competitive players, others suit beginners or families. Below you'll find an overview with address, court count, and type (indoor/outdoor) to help you choose."

### c) Expand lessons text (~50 → ~100 words)
Expand `lessonsTemplates` to mention: what a first lesson looks like, that most trainers speak Dutch and English, that PadelTrainer.ai handles booking.

**File**: `src/pages/marketing/CityLanding.tsx`
- Render the club intro paragraph above the clubs grid
- Split the city intro into two `<p>` tags for readability

## 4. Improve FAQ answer length
**File**: `src/lib/cityContent.ts`

Pass `locations` data into `generateFAQs` (change signature to accept locations array and trainerCounts). Expand each FAQ answer to 2-3 sentences using dynamic data:
- Club count answer: mention indoor/outdoor split and top club names
- Lesson cost: mention that PadelTrainer.ai lets you compare prices
- Indoor question: use actual indoor count
- Racket question: mention club names that offer rental
- Best trainer: mention number of active trainers

## 5. Add hero stats (indoor/outdoor/trainers)
**File**: `src/pages/marketing/CityLanding.tsx`

Expand the hero stats row from `Clubs | Coaches` to `Clubs | Indoor | Outdoor | Trainers`. Compute indoor/outdoor counts from locations data.

Add new i18n keys: `indoor`, `outdoor` across all 5 locales.

## 6. Link blog posts section
**File**: `src/pages/marketing/CityLanding.tsx`

Add a "More about padel" section before the FAQ with 2-3 learning article cards fetched from Sanity via `getLearningArticles()`. Show as simple linked cards with title and excerpt. Only render if articles are found.

Add i18n key: `moreAboutPadel` across all 5 locales.

## 7. Club card enhancements
**File**: `src/components/locations/LocationCard.tsx`

- Add explicit "View club" link text at the bottom of each card (visible text, not just clickable card)
- The MapPin icon is already there — no change needed

Add i18n key: `viewClub` to common translations.

## 8. City-specific OG image
**File**: `src/pages/marketing/CityLanding.tsx`

For now, set a dynamic OG title + description per city (already done). For the image, construct a dynamic OG image URL using a simple text-on-background approach — create a small edge function `og-image` that generates a branded PNG with "Padel in [City] — [X] clubs" text overlay on the PadelTrainer.ai branded background. Pass city and count as query params.

**File**: `supabase/functions/og-image/index.ts` — new edge function that generates a simple branded OG image using canvas/SVG-to-PNG.

## Files Changed Summary

| File | Change |
|------|--------|
| `src/pages/marketing/CityLanding.tsx` | Nearby cities casing fix, always-show trainers section, club intro paragraph, expanded hero stats, blog posts section, OG image URL |
| `src/lib/cityContent.ts` | Expanded intro/lessons templates, new `generateClubIntro()`, enriched FAQ answers with location data |
| `src/components/locations/LocationCard.tsx` | Add "View club" link text |
| `src/i18n/locales/[en,nl,de,es,fr]/marketing.json` | New keys: `noTrainersMessage`, `becomeTrainer`, `indoor`, `outdoor`, `moreAboutPadel`, `clubIntro` |
| `src/i18n/locales/[en,nl,de,es,fr]/common.json` | New key: `viewClub` |
| `supabase/functions/og-image/index.ts` | New edge function for dynamic OG images |

