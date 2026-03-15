

## SEO & Performance Audit of Sanity Pages

### Current State — What's Already Good
- All detail pages have dynamic SEO meta tags from Sanity (title, description, canonical, hreflang, noIndex)
- Structured data (JSON-LD) on Blog, Rules, Strokes, Coaches, Video Tips detail pages
- Pre-rendering system handles bots/crawlers for all routes
- Sanity CDN enabled (`useCdn: true`) for fast reads
- TanStack Query caching (5-10 min staleTime) on all pages
- Skeleton loaders on all pages

### Issues Found & Fixes

**1. RulesPage missing `noIndex` support**
- `RulesPage.tsx` does not pass `noIndex` to the `<SEO>` component, even though it reads `seo` from Sanity. Simple one-line fix.

**2. Listing pages missing structured data**
- Coaches, Strokes, Video Tips, and Rules listing pages have no JSON-LD structured data. Adding `ItemList` schema to each would help search engines understand these as navigable collections and can enable rich results.

**3. Coaches listing page missing `staleTime`**
- `Coaches.tsx` query has no `staleTime`, causing unnecessary refetches. Should match other listing pages (10 min).

**4. Rules listing page missing `staleTime`**
- Same issue on `Rules.tsx` — no staleTime configured.

### Files Changed
1. `src/pages/marketing/RulesPage.tsx` — Add `noIndex={article.seo?.indexable === false}`
2. `src/pages/marketing/Rules.tsx` — Add `staleTime`, add `ItemList` structured data
3. `src/pages/marketing/Coaches.tsx` — Add `staleTime`, add `ItemList` structured data
4. `src/pages/marketing/Strokes.tsx` — Add `ItemList` structured data
5. `src/pages/marketing/VideoTips.tsx` — Add `ItemList` structured data

All small, targeted changes. No redesigns needed.

