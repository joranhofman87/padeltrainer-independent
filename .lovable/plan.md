

# CMS Banner / Sponsor Ad System

## What we're building
A reusable banner system that fetches ad banners from Sanity CMS, renders them in designated zones across the site, and tracks impressions + clicks via PostHog.

## Files to create

### 1. `src/lib/banners.ts` — Query helper
- `getBannersByZone(zone, options?)` — GROQ query fetching active banners where `isActive == true`, sponsor is active, and date range is valid
- Client-side filtering for `targetLanguages` and `targetCategories`
- `pickWeightedBanner(banners)` — weighted random selection (higher weight = more impressions)
- Uses existing `sanityClient` from `src/lib/sanity.ts`

### 2. `src/components/sponsors/BannerAd.tsx` — Render component
- Receives a single banner object, renders image with click-through link
- `IntersectionObserver` (50% threshold) fires `banner_impression` event once per mount
- Click handler fires `banner_click` event
- Uses existing `trackEvent` from `src/lib/tracking.ts` (not `usePostHog` hook — this app doesn't use the PostHog React provider)
- `rel="noopener noreferrer sponsored"` on links for SEO
- "Sponsored" label on hover, lazy-loaded image, optional CTA badge

### 3. `src/components/sponsors/BannerZone.tsx` — Zone wrapper
- Takes `zone`, optional `language`, `category`, `className` props
- Uses `useQuery` (TanStack) to fetch banners with 10-min staleTime (matches existing caching pattern)
- Picks a weighted-random banner from results via `useMemo`
- Renders `<BannerAd>` or `null` if no banners available
- Gets current language from `useTranslation` hook automatically

### 4. Initial placements
Drop `<BannerZone>` into these pages:
- **Home.tsx** — `zone="homepage-hero"` after SocialProofStrip
- **BlogPost.tsx** — `zone="in-article"` after article content
- **Blog.tsx** — `zone="blog-listing"` in the listing page (passes category)

## PostHog events
Both events include: `banner_id`, `banner_tracking_id`, `banner_title`, `sponsor_name`, `sponsor_slug`, `sponsor_plan`, `zone`, `click_url`

| Event | Trigger |
|---|---|
| `banner_impression` | Banner 50% visible (once per mount) |
| `banner_click` | User clicks banner link |

## Technical notes
- No new dependencies needed — uses existing `sanityClient`, `trackEvent`, `useQuery`, `useTranslation`
- Adapts the user's prompt from Next.js patterns (server components, `usePostHog`) to this app's React/Vite architecture
- Banner zone values match Sanity schema exactly: `header`, `sidebar`, `in-article`, `footer`, `blog-listing`, `homepage-hero`

