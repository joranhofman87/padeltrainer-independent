

# Sitemap Audit — Issues Found & Fixes

## Issues Identified

### 1. CRITICAL: Cloudflare Worker missing `content` sitemap route
The `getSitemapProxyUrl` function in `docs/cloudflare-worker.js` handles `static`, `provinces`, `locations-N`, and `cities-N` — but **not** `sitemap-content.xml`. When Google requests `/sitemaps/sitemap-content.xml` directly (not via CI), the Cloudflare worker falls through to the origin static file instead of proxying to the edge function. This means live/real-time content sitemap requests from crawlers won't work if the static file is stale or missing.

### 2. CRITICAL: Trainers query hits 1000-row limit
Line 251–253 fetches trainers with a single `supabase.from('trainer_profiles').select(...)` — no pagination. If you have more than 1,000 trainer profiles, the rest are silently dropped from the sitemap.

### 3. MODERATE: Blog articles query hits 1000-row limit
Line 277–280 fetches blog articles with a single query. Same truncation risk if you grow past 1,000 published articles.

### 4. MODERATE: Academies query hits 1000-row limit
Line 263–267 — same pattern. Lower risk now but will bite you as you grow.

### 5. MODERATE: No XML escaping on slugs
Slugs and city names are inserted directly into XML without escaping `&`, `<`, `>`. A single slug containing `&` (e.g., a location called "Bar & Restaurant") will produce malformed XML that Google will reject entirely for that sitemap file.

### 6. LOW: City slug double-encoding
`encodeURIComponent()` on line 189/366 encodes special characters like `ñ` → `%C3%B1`, `ü` → `%C3%BC`. If your frontend routes use raw UTF-8 slugs (e.g., `/trainers/logroño`), the sitemap URLs won't match and Google will see 404s.

## Plan

### File 1: `supabase/functions/sitemap/index.ts`

**A) Add XML escape helper**
```typescript
function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```
Apply in `generateUrlEntry`, `generateBlogEntries`, and `generateSanityEntries` — wrap all dynamic path/slug values with `escapeXml()`.

**B) Fix trainers, academies, blog queries to use `fetchAllRows`**
Replace the three single queries with:
```typescript
// Trainers
const trainers = await fetchAllRows<{user_id: string; slug: string; updated_at: string}>(
  supabase, 'trainer_profiles', 'user_id, slug, updated_at'
);

// Academies
const academies = await fetchAllRows<{slug: string; updated_at: string}>(
  supabase, 'academy_profiles', 'slug, updated_at',
  [
    { column: 'is_verified', operator: 'eq', value: true },
    { column: 'is_public', operator: 'eq', value: true }
  ]
);

// Blog
const blogArticles = await fetchAllRows<{slug: string; locale: string; canonical_id: string; published_at: string; updated_at: string}>(
  supabase, 'articles', 'slug, locale, canonical_id, published_at, updated_at',
  [{ column: 'status', operator: 'eq', value: 'published' }]
);
```

**C) Fix city slug encoding**
Replace `encodeURIComponent(loc.city.toLowerCase().replace(/\s+/g, '-'))` with just `loc.city.toLowerCase().replace(/\s+/g, '-')` — no URI encoding. The XML `escapeXml` helper handles any special XML chars. This ensures URLs match your frontend routing.

### File 2: `docs/cloudflare-worker.js`

Add the missing content sitemap route to `getSitemapProxyUrl`:
```javascript
if (pathname === '/sitemaps/sitemap-content.xml') return `${sitemapFunctionUrl}?type=content`;
```

## File Summary

| File | Change |
|---|---|
| `supabase/functions/sitemap/index.ts` | Add XML escaping; use `fetchAllRows` for trainers/academies/blog; fix city slug encoding |
| `docs/cloudflare-worker.js` | Add missing `sitemap-content.xml` proxy route |

