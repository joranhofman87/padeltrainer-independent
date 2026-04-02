

# Make Rating Progress Card Shareable & Viral

## Overview

Transform the "Download image" button into a full social sharing system: a branded dark social card (canvas-rendered, not a screenshot), a public shareable page with OG tags, Web Share API, and dynamic celebration text with milestone badges.

## Architecture

```text
Player clicks "Download" or "Share"
        │
        ├── Download → Canvas-rendered 1080x1350 dark social card (PNG)
        │
        └── Share → Mobile: Web Share API (shares image + URL)
                    Desktop: Dropdown (WhatsApp, X, Copy link)
                              │
                              └── URL: padeltrainer.ai/:lang/rating/:profileId
                                        │
                                        ├── Public page: shows visual card + CTA
                                        └── OG image: edge function renders SVG
```

## Changes

### 1. Social card image generator (`src/components/player/RatingShareCard.tsx`)

New component that renders a hidden 1080x1350 canvas-like div (off-screen, captured via `html-to-image`):

- **Dark gradient background** (#1a1a2e → #16213e)
- **PadelTrainer.ai logo** top center (use the light variant)
- **Player first name** + "Padel Rating Journey"
- **Two large stat boxes**: Start rating | Current rating (white, bold, 48px+)
- **Improvement badge**: "+3.8 punten verbeterd!" in green with glow
- **Embedded chart**: Recharts AreaChart with orange line (#F97316) on dark bg, gradient fill
- **Dynamic celebration text** based on improvement level (see below)
- **Time stats**: "Sinds apr '23 bezig" + "X maanden progressie"
- **Bottom**: subtle divider + "Track jouw rating op padeltrainer.ai"
- **Round corners** (24px), no UI chrome

The component renders absolutely positioned off-screen, captured with `toPng` at 2x pixel ratio when user clicks download.

### 2. Dynamic celebration text logic

Inside the share card, pick message based on data:

| Condition | Message |
|-----------|---------|
| Improved >= 3 pts | "🚀 Ongelofelijk! [X] punten verbeterd" |
| Improved 1-3 pts | "📈 Stijgende lijn! +[X] punten" |
| Improved < 1 pt | "💪 Stap voor stap beter" |
| At all-time best | "🏆 All-time best rating!" |
| Fallback | "📊 [X] punten verbeterd sinds de start" |

Time message: "Sinds [MMM] '[YY] actief" + "[X] maanden padel progressie"

### 3. Milestone badges

Show 1-3 small badge pills on the social card when earned:
- "🔥 3+ punten verbeterd" (improvement >= 3)
- "📅 1 jaar actief" (history spans 12+ months)
- "🏆 All-time high" (current == best)

### 4. Update `RatingHistoryChart.tsx` — Share + Download buttons

Replace single download button with two buttons:
- **Download image** — renders the dark social card off-screen, captures as PNG
- **Share** — on mobile: `navigator.share()` with the PNG blob + shareable URL. On desktop: dropdown with WhatsApp (`wa.me` deep link), X (tweet intent), Copy link

Pass `playerName` prop from `PlayerDashboard.tsx` (from `profile.full_name`).

### 5. Public shareable page (`src/pages/marketing/PublicRatingCard.tsx`)

New page at `/:lang/rating/:profileId`:
- Fetches profile name, rating history, rating system from DB
- Renders the same visual card (dark background, chart, stats) as the social card but as actual page content
- Below the card: CTA section "Track jouw padel rating" + signup button
- SEO: `<title>`, `<meta>` OG tags set dynamically
- Minimal page — just the visual + CTA, no nav/footer clutter

**Route**: Add to `DomainRouter.tsx` under the `/:lang` marketing routes.

**RLS**: The `player_rating_history` and `profiles` tables need a SELECT policy for anonymous access on this specific data (name + rating history). Add an RLS policy: "Anyone can read profiles for public rating pages" scoped to `full_name, avatar_url, skill_rating, rating_system` columns — or better, create an edge function that fetches the data server-side and returns only what's needed.

Decision: Use an **edge function** (`get-public-rating`) to fetch the data server-side, avoiding any new public RLS policies. The public page calls this function.

### 6. OG image edge function (`supabase/functions/rating-og-image/index.ts`)

New edge function that generates an SVG-based OG image (1200x630) for the shareable URL. Similar to the existing `og-image` function but for ratings:

- Dark gradient background
- Player name + rating numbers (start → current)
- Improvement badge
- Mini chart representation (simplified polyline)
- PadelTrainer.ai branding

The `render-page` function needs a new route handler for `/rating/:profileId` to set OG meta tags pointing to this image.

### 7. Update `render-page` edge function

Add a new route match for `/rating/:profileId`:
- Fetch profile + rating history via service role
- Set OG tags: `og:title`, `og:description`, `og:image` (pointing to `rating-og-image` function)
- Return pre-rendered HTML with meta tags

## Files changed

| File | Change |
|------|--------|
| `src/components/player/RatingShareCard.tsx` | **New** — dark branded social card component (1080x1350) |
| `src/components/player/RatingHistoryChart.tsx` | Add Share button, pass to share card, accept `playerName` prop |
| `src/pages/PlayerDashboard.tsx` | Pass `profile.full_name` to RatingHistoryChart |
| `src/pages/marketing/PublicRatingCard.tsx` | **New** — public shareable page with visual card + CTA |
| `src/components/DomainRouter.tsx` | Add route `rating/:profileId` under `/:lang` |
| `supabase/functions/get-public-rating/index.ts` | **New** — edge function returning public-safe rating data |
| `supabase/functions/rating-og-image/index.ts` | **New** — SVG OG image for social sharing |
| `supabase/functions/render-page/index.ts` | Add `/rating/:profileId` route for OG meta pre-rendering |
| `src/i18n/locales/*/player.json` | New keys for celebration text, share labels |

## DB changes

None — no new tables or RLS policies. The edge function uses the service role key to fetch data server-side.

## Priority order

1. Social card component (the visual — biggest impact)
2. Download button update (captures the card as PNG)
3. Share button with Web Share API + desktop fallback
4. Public page + edge function for data
5. OG image edge function
6. render-page update for OG meta
7. Celebration text + milestone badges (sprinkled into step 1)

