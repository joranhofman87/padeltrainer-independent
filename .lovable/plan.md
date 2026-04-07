

# Fix: Supabase 1000-Row Default Limit on Location Sitemaps

## Problem

The `type=locations` handler uses a single `supabase.from('locations').range(start, end)` query. Supabase has a **default maximum of 1,000 rows per query**. So even though `LOCATIONS_PER_PAGE = 2500`, only 1,000 rows come back.

Evidence from your screenshot:
- 5,000 `<url>` tags per page = 1,000 locations × 5 languages
- Expected: 12,500 `<url>` tags = 2,500 locations × 5 languages
- Total locations in sitemap: ~5,005 instead of ~13,000+

Cities work correctly because they use the `fetchAllRows` helper which internally paginates in batches of 1,000.

## Fix

**`supabase/functions/sitemap/index.ts`** — Replace the single `.range()` query in the `type === 'locations'` handler with the existing `fetchAllRows` helper, then slice the results for the requested page:

```typescript
} else if (type === 'locations') {
  xml = xmlHeader();

  const start = (page - 1) * LOCATIONS_PER_PAGE;

  // Use fetchAllRows to bypass 1000-row limit, then slice for this page
  const allLocations = await fetchAllRows<{ slug: string; city: string; updated_at: string }>(
    supabase, 'locations', 'slug, city, updated_at',
    [{ column: 'is_active', operator: 'eq', value: true }],
    'slug'
  );

  const pageLocations = allLocations.slice(start, start + LOCATIONS_PER_PAGE);

  for (const location of pageLocations) {
    const lastmod = location.updated_at
      ? new Date(location.updated_at).toISOString().split('T')[0]
      : today;
    xml += generateUrlEntry(`/locations/${location.slug}`, lastmod, 'weekly', '0.6');
  }

  xml += '</urlset>';
```

This reuses the same `fetchAllRows` pattern that already works for cities. Each page will now correctly contain up to 2,500 locations (12,500 `<url>` entries).

## Expected Result After Fix

- Location pages 1-5: ~12,500 URLs each
- Location page 6: remaining URLs
- Total location URLs: ~65,000+ (13,000 locations × 5 languages)

## Performance Note

This fetches all ~13,000 location rows on every location-page request, which is heavier than a single range query. But since this runs once per week via CI, it's acceptable. If it causes timeouts, a follow-up optimization would be to implement true server-side pagination in batches of 1,000 within the range window.

## Files Changed

| File | Change |
|---|---|
| `supabase/functions/sitemap/index.ts` | Replace single `.range()` query with `fetchAllRows` + `.slice()` in locations handler |

