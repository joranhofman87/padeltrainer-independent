

# Updated Plan: Padel Racket Product Pages (with Manual Related Products)

## What changed from the approved plan
One addition: the `RACKET_BY_SLUG_QUERY` now includes a `manualRelated` projection from the new `relatedProducts` reference array. The detail page uses a hybrid approach — manual picks if available, auto-query fallback otherwise.

## Files to Create/Modify

### 1. `src/lib/sanity.ts` — Add 3 GROQ queries
- `RACKET_BY_SLUG_QUERY`: Single racket with all fields + SEO + `"manualRelated": relatedProducts[]-> { _id, name, slug, brand, priceRange, shortDescription, shape, image, level, playingStyle }`
- `RELATED_RACKETS_QUERY`: Auto-fallback (same style + level, exclude current, limit 4)
- `RACKETS_LIST_QUERY`: All rackets for listing page

### 2. `src/pages/marketing/RacketListing.tsx` — Listing page
Grid with client-side filters (brand, level, style, shape, weight, price, armFriendly), URL param sync, result count, clear-all. Uses `RacketCard` grid.

### 3. `src/pages/marketing/RacketDetail.tsx` — Detail page
Hero (image/fallback + name/brand/price/CTA), Quick Specs grid (parsed from pipe-delimited string), At a Glance badges, full description (Portable Text), Similar Rackets section, Product JSON-LD, breadcrumbs, PostHog tracking.

**Related rackets logic:**
```tsx
const related = racket.manualRelated?.length > 0
  ? racket.manualRelated
  : autoRelatedRackets
```
Only fire the auto-fallback query when `manualRelated` is empty.

### 4. `src/components/gear/RacketCard.tsx`
Reusable card with image/fallback, level badge (green/blue/purple), style badge (teal/amber/red), armFriendly badge, price, "View Details" link.

### 5. `src/components/gear/RacketImage.tsx`
Brand-colored fallback with shape icon when no image. Brand color map for ~12 brands.

### 6. `src/components/gear/RacketFilters.tsx`
Filter controls: brand checkboxes, single-select badges for level/style/shape/weight, price buckets, armFriendly toggle.

### 7. `src/components/DomainRouter.tsx`
Add lazy imports + routes for `gear/rackets` and `gear/rackets/:slug`.

### 8. i18n files (5 locales)
Add `gear.*` keys: page titles, filter labels, badge labels, CTA text, breadcrumb labels, specs icon labels.

### 9. `src/hooks/useRacketFinderQuery.ts`
Extend `RacketResult` interface with `image`, `shop`, `isAvailable`, `description` fields.

## Technical Notes
- Affiliate links use `rel="nofollow noopener sponsored"`
- Product JSON-LD with `AggregateOffer` parsed from `priceRange`
- "Take the Quiz" CTA links to `/gear/racket-finder?level={level}&style={playingStyle}`
- Auto-fallback query only enabled when `!racket.manualRelated?.length`

