

# Rate My Padel Court — Implementation Plan

## What We're Building

A community court review tool at `/:lang/playground/rate-my-court` where players rate clubs across 10 padel-specific categories. Reviews link directly to existing `locations` in the database, building unique user-generated content per club that feeds into location/city pages for SEO.

## Key Design Decision: Use Existing `locations` Table

The prompt suggests a separate "Club" data model. We should skip that entirely and connect reviews directly to the existing `locations` table. This means:
- No duplicate club data to maintain
- Reviews immediately enrich existing location pages
- Club search uses the same data powering city pages
- `aggregateRating` JSON-LD on location pages can blend Google + community ratings

## Database (2 new tables, 1 migration)

### `court_reviews` table
- `id`, `location_id` (FK → locations), `user_id` (FK → auth.users, nullable for email-only), `reviewer_email`
- 10 rating columns (smallint 1-5): `rating_surface`, `rating_glass`, `rating_lighting`, `rating_space`, `rating_changing_rooms`, `rating_booking`, `rating_value`, `rating_atmosphere`, `rating_parking`, `rating_beginner_friendly`
- `overall_rating` (numeric, computed as average on insert via trigger)
- `best_thing` (text, max 200), `improvement` (text, max 200)
- `player_level` (enum: beginner/intermediate/advanced/pro)
- `play_frequency` (enum: first_time/few_times/regularly/home_club)
- `status` (enum: pending/approved/rejected, default pending)
- `created_at`, `updated_at`
- Unique constraint on `(location_id, reviewer_email)` — one review per club per user
- RLS: anyone can insert (with rate limiting in app), only approved reviews visible to public reads, admins can manage all

### `location_review_stats` materialized view (or computed columns)
- Per-location: average overall, average per category, total review count
- Refreshed via trigger on review approve/reject
- Alternatively: a simple DB function `get_location_review_stats(location_id)` that computes on read (simpler for MVP)

## Frontend Components (Phase 1 MVP)

### 1. Playground Hub Card
Add 4th card to `Playground.tsx`:
- Emoji: ⭐, title: "Rate My Padel Court"
- Route: `/playground/rate-my-court`

### 2. Rate My Court Page (`src/pages/marketing/RateMyCourtPage.tsx`)
Three-step flow in a single page:

**Step 1 — Find Your Club**
- Search input querying `locations` table (name, city)
- Show popular/recently reviewed clubs as cards below
- Each card: club name, city, country flag, avg rating if reviews exist

**Step 2 — Rate (10 categories)**
- Club name header
- 10 rows: category label + 5-star input (orange filled stars)
- Optional fields: best thing, improvement, frequency dropdown, level dropdown
- Progress indicator (X/10 categories rated)

**Step 3 — Auth Gate**
- If logged in → submit directly (link to their `user_id`)
- If not → require sign-in or sign-up (existing auth flow)
- One review per club per user enforced by unique constraint

**Step 4 — Confirmation**
- Summary card of submitted ratings
- "Rate another club" + "Share" buttons

### 3. Admin Review Moderation (`src/pages/admin/AdminReviews.tsx`)
- Table of pending reviews with club name, ratings summary, comments, date
- Approve/Reject buttons
- Filter by status (pending/approved/rejected)
- Add to existing admin sidebar navigation

### 4. Location Page Integration
- On `LocationDetail.tsx`, add a "Community Ratings" section below existing content
- Show rating breakdown bars (10 categories) if approved reviews exist
- Show individual review cards
- "Rate This Club" CTA button linking to the review tool with location pre-selected

## Routing Updates

| File | Change |
|---|---|
| `DomainRouter.tsx` | Add `playground/rate-my-court` route |
| `Playground.tsx` | Add 4th tool card |
| `sitemap/index.ts` | Add `/playground/rate-my-court` to static pages |
| `render-page/index.ts` | Add meta tags for the tool page |
| `llms.txt` | Add URL |

## i18n

Add keys to all 6 `marketing.json` files:
- `playground.rateMyCourtPage.*` — page title, subtitle, category labels, form labels, CTAs
- `playground.rateMyCourt.title/desc` — hub card text

## SEO Value

- Each location page gains unique UGC content
- Structured data: `AggregateRating` from community reviews alongside Google ratings
- Long-tail queries like "best padel courts for beginners in [city]" served by category-specific data
- City page integration (Phase 2): "Top Rated Courts" section pulling from review stats

## What We're NOT Building Yet (Phase 2+)

- Radar/spider chart visualization
- City page "Top Rated Courts" section
- Photo uploads with reviews
- "Was this helpful?" voting
- Auto-approve rules
- Club owner claim/response
- Compare clubs side-by-side
- Shareable review image card

## File Summary

| File | Change |
|---|---|
| Migration SQL | Create `court_reviews` table, enums, RLS policies, stats function |
| `src/pages/marketing/RateMyCourtPage.tsx` | New — main review tool page |
| `src/pages/admin/AdminReviews.tsx` | New — moderation queue |
| `src/components/ratecourt/*` | New — ClubSearch, RatingForm, ReviewCard components |
| `src/hooks/useCourtReviews.ts` | New — queries for reviews + stats |
| `src/pages/marketing/Playground.tsx` | Add 4th card |
| `src/components/DomainRouter.tsx` | Add route |
| `src/pages/LocationDetail.tsx` | Add community ratings section |
| `src/pages/admin/AdminSidebar` or equivalent | Add Reviews nav item |
| 6x `marketing.json` | Translation keys |
| `sitemap/index.ts` | Add static page |
| `render-page/index.ts` | Add meta tags |
| `llms.txt` | Add URL |

