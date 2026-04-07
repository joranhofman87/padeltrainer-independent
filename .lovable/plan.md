

# Location Page SEO Optimization

## Current State

Your location pages have a decent foundation — `SportsClub` schema, `BreadcrumbList`, and `SEO` component with OG tags. But several high-value properties are missing that would significantly improve rich result eligibility now that these pages are ranking.

## Issues Found

### LocationDetail.tsx — 6 gaps

| Gap | Impact |
|-----|--------|
| **No `geo` coordinates** in structured data | Location data has `latitude`/`longitude` but they're not in the schema — Google needs `GeoCoordinates` for map pack eligibility |
| **No `telephone`** | `location.phone` exists in the data model but isn't in schema |
| **No `openingHours`** | `location.opening_hours` exists but isn't in schema |
| **No `aggregateRating`** | Google reviews (`google_rating`, `google_review_count`) are available but not in schema — missing star snippets |
| **Hardcoded `addressCountry: "NL"`** | Location model has a `country` field but the schema ignores it |
| **No `url` pointing to canonical page** | The `url` field uses `location.website_url` (external) — should also have the PadelTrainer canonical URL |

### CityLanding.tsx — 2 gaps

| Gap | Impact |
|-----|--------|
| **`LocalBusiness` schemas missing `telephone`/`openingHours`** | Same data available but not used |
| **Hardcoded English text in breadcrumb/hero** | `"Home"`, `"Padel in {city}"` not translated — bad for non-EN rankings |

### Locations.tsx (listing) — 1 gap

| Gap | Impact |
|-----|--------|
| **No `BreadcrumbList` JSON-LD** | Listing page has no breadcrumb schema |

### render-page edge function — minor

The location pre-render uses generic English text. Not blocking but could match the actual location name from DB for better bot meta.

---

## Changes

### 1. `src/pages/LocationDetail.tsx` — Enrich `SportsClub` schema

Add to `getStructuredData()`:
- `geo: { @type: GeoCoordinates, latitude, longitude }` (when available)
- `telephone` from `location.phone`
- `openingHoursSpecification` from `location.opening_hours` (if parseable) or raw `openingHours`
- `aggregateRating` from `location.google_rating` + `location.google_review_count`
- `addressCountry` from `location.country` instead of hardcoded `"NL"`
- `sameAs` array with `location.website_url`, social links from clubProfile
- `url` pointing to the canonical PadelTrainer page URL

### 2. `src/pages/marketing/CityLanding.tsx` — Enrich `LocalBusiness` + fix i18n

- Add `telephone` to `LocalBusiness` schemas (need to fetch phone from location data)
- Translate hardcoded breadcrumb text (`"Home"`) — use `t()` keys

### 3. `src/pages/Locations.tsx` — Add `BreadcrumbList`

Add breadcrumb JSON-LD: Home → Locations

---

## File Summary

| File | Change |
|------|--------|
| `src/pages/LocationDetail.tsx` | Add `geo`, `telephone`, `aggregateRating`, `sameAs`, fix `addressCountry`, add canonical `url` |
| `src/pages/marketing/CityLanding.tsx` | Translate hardcoded breadcrumb text |
| `src/pages/Locations.tsx` | Add `BreadcrumbList` JSON-LD |

