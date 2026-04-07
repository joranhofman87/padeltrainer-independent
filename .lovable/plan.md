

# Fix: sitemap-cities-2.xml returning 0 URLs / error in GSC

## Root Cause

Each city generates **10 `<url>` entries** (2 paths × 5 languages). With `CITIES_PER_PAGE = 5000`, that's exactly **50,000 URLs per page** — Google's hard maximum per sitemap file.

The problem: your unique city count is very close to 5000. The sitemap index is generated separately from the sub-sitemaps (by the GitHub Action fetching them sequentially). If there were briefly >5000 cities when the index was built, it references `sitemap-cities-2.xml`. But when Google later fetches cities-2, there are 0 or very few cities left for page 2 — producing an empty or near-empty sitemap that Google flags as an error.

Additionally, sitting at exactly 50,000 URLs on cities-1 is risky — any slight increase could push it over Google's limit.

## Fix

Reduce `CITIES_PER_PAGE` from 5000 to **2500**. This means:
- Each cities sub-sitemap has at most 25,000 URLs (well under the 50,000 limit)
- With ~5000 cities, you get 2 properly-filled sub-sitemaps instead of one maxed-out + one empty

Also apply the same logic to `LOCATIONS_PER_PAGE` — each location generates 5 `<url>` entries (5 languages), so 5000 locations = 25,000 URLs, which is fine. But reducing to 2500 gives more headroom as locations grow.

## Change

**`supabase/functions/sitemap/index.ts`** — line 12-13:
```typescript
const LOCATIONS_PER_PAGE = 2500;
const CITIES_PER_PAGE = 2500;
```

One-line change, no other files affected. After deploying, re-submit the sitemap index in GSC to pick up the corrected pagination.

