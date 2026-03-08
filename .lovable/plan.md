

# Sponsor Banner System — Full Plan

## Current State

You already have a `partner_banners` table and an admin CRUD page at `/admin/banners`. However:
- **No front-end display** — banners are never rendered to users
- **No tracking** — impressions/clicks are columns on the table but never incremented
- **No placement system** — no concept of where banners appear (sidebar, header, in-feed, etc.)
- **No rotation logic** — no auto-cycling between multiple banners
- **No event log** — only aggregate counters, no per-event data for analytics

## What to Build

### 1. Database: Placements + Event Log

**New table: `banner_placements`** — defines where banners can appear
- `id`, `slug` (e.g. `location-detail-sidebar`, `marketing-hero`, `trainer-search-top`), `label`, `description`, `width`, `height`, `created_at`

**New table: `banner_placement_assignments`** — links banners to placements (many-to-many)
- `id`, `banner_id` → `partner_banners.id`, `placement_id` → `banner_placements.id`, `priority` (for rotation order), `weight` (for weighted random rotation), `is_active`, `created_at`

**New table: `banner_events`** — granular event log for analytics
- `id`, `banner_id`, `placement_id`, `event_type` (enum: `impression`, `click`), `user_id` (nullable), `session_id` (anonymous tracking), `page_url`, `referrer`, `user_agent`, `ip_hash` (privacy-safe hashed IP), `created_at`
- Indexed on `(banner_id, event_type, created_at)` for fast reporting

**Modify `partner_banners`**: Add `sponsor_name`, `sponsor_logo_url`, `budget_type` (enum: `unlimited`, `impression_cap`, `click_cap`), `budget_cap` (nullable int), `format` (enum: `image`, `html`)

### 2. Edge Function: Track Events

An edge function `track-banner-event` that:
- Accepts `{ banner_id, placement_id, event_type, page_url, session_id }`
- Hashes IP for fraud detection (no raw IP stored)
- Deduplicates impressions (same session + banner + placement within 30 min = 1 impression)
- Inserts into `banner_events`
- Increments the aggregate counters on `partner_banners` (click_count / impression_count)
- Checks budget caps and auto-deactivates banners that hit their limit

### 3. Front-end: `<SponsorBanner>` Component

A reusable component that:
- Takes a `placementSlug` prop
- Fetches active banners assigned to that placement (filtered by date range, location, active status)
- **Auto-rotates** using weighted random selection when multiple banners exist
- Fires an impression event when the banner enters the viewport (IntersectionObserver)
- Fires a click event on link click, then redirects
- Shows a subtle "Sponsored" label for transparency
- Returns `null` if no active banners exist (no empty space)
- Rotation interval configurable per placement (e.g. every 15 seconds)

### 4. Place Banners Across the App

Specific placements to create:
- **`location-detail-sidebar`** — on club pages without premium subscription
- **`trainer-search-results`** — between search results on the trainer listing
- **`marketing-homepage`** — on the public landing page
- **`app-dashboard`** — in the logged-in dashboard (if free tier)

### 5. Admin: Enhanced Banner Management

Upgrade the existing `/admin/banners` page:
- **Placement assignment UI** — assign banners to one or more placements with weight/priority
- **Sponsor details** — sponsor name, logo, budget settings
- **Analytics dashboard** — impressions, clicks, CTR, unique viewers per banner per placement, with date range filter
- **Budget indicators** — show progress toward caps, warnings at 80%
- **Preview** — render banner as it would appear in each assigned placement

### 6. Additional Important Features

- **Frequency capping**: Limit how many times a single user sees the same banner per day (stored in `banner_events` dedup logic)
- **A/B testing support**: Multiple image variants per banner, tracked separately
- **Geo-targeting**: Already have `location_id` — extend to country/city level for marketing pages
- **Scheduling**: Already have `start_date`/`end_date` — enforced at query time
- **Fraud protection**: IP hash dedup, rate limiting in edge function
- **Reporting export**: CSV download of event data for sponsors

## Implementation Order

1. **Database migrations** — new tables + enum types + indexes
2. **Edge function** — `track-banner-event` with dedup + budget logic
3. **`<SponsorBanner>` component** — fetch, rotate, track
4. **Place banners** on 3-4 key pages
5. **Admin UI upgrades** — placement management + analytics dashboard

## Files to Create/Modify

- `supabase/functions/track-banner-event/index.ts` (new)
- `src/components/sponsors/SponsorBanner.tsx` (new)
- `src/hooks/useBannerRotation.ts` (new)
- `src/pages/admin/AdminBanners.tsx` (extend with placements + analytics)
- `src/pages/LocationDetail.tsx` (add sidebar placement)
- `src/pages/marketing/Home.tsx` (add homepage placement)
- Database migration for new tables

