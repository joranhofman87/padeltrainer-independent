

# SEO Audit: Sitemap, City Pages & Improvements

## Current State Assessment

**Sitemap**: Well-structured. Covers static pages (10), trainer profiles, 1400+ locations, city landing pages, academies, and blog articles — all in 5 languages with proper hreflang. Regenerated daily via GitHub Action. Uses pagination for >1000 rows. This is solid.

**City pages**: Every city that has at least one active location gets a `/trainers/{city-slug}` page in the sitemap. These pages have good SEO fundamentals: JSON-LD (FAQPage + BreadcrumbList), dynamic meta descriptions with trainer counts and price ranges, and FAQ sections.

## Issues Found

1. **Nearby Cities section is broken** — The code at line 594-600 computes `nearbyCities` but always returns `null`. This is a missed internal linking opportunity, which is one of the highest-impact SEO signals for programmatic pages.

2. **City page content is English-only** — All text on `TrainersCity.tsx` is hardcoded in English ("Padel Trainers in...", "How much do padel lessons cost in...", FAQ answers, etc.) despite having 5 language routes. Google will see Dutch/Spanish/German/French URLs serving English content — bad for rankings.

3. **Blog articles missing hreflang** — In the sitemap, blog articles are added as single-locale entries without `xhtml:link` alternates, unlike every other page type. If you have the same article in multiple languages, Google can't connect them.

4. **No province/region landing pages** — You have city pages but no aggregation layer (e.g., `/trainers/province/noord-holland`). Province pages would capture broader "padel trainer [region]" searches and provide internal linking structure.

5. **Breadcrumb structured data uses hardcoded `/en/`** — The BreadcrumbList JSON-LD always points to `padeltrainer.ai/en/trainers` regardless of current language.

6. **No sitemap index** — With 5 languages × (10 static + trainers + 1400 locations + cities + academies + blog), the sitemap is likely very large. Google recommends splitting into a sitemap index with sub-sitemaps when exceeding ~50K URLs.

## Plan

### 1. Fix Nearby Cities (internal linking)
- Fetch all cities with their trainer counts in `TrainersCity.tsx`
- Render a "Nearby Cities" section at the bottom with links to 6-8 other city pages
- Massive SEO win: creates a web of internal links across all city pages

### 2. Translate city page content
- Move all hardcoded strings in `TrainersCity.tsx` to the i18n translation files
- Add `cityPage` keys to all 5 `marketing.json` files with interpolation for `{{city}}`, `{{count}}`, etc.
- Fix breadcrumb structured data to use current language

### 3. Fix blog hreflang in sitemap
- Group blog articles by slug, then generate hreflang links between locale variants
- Only applies when the same slug exists in multiple locales

### 4. Add province/region pages (new)
- Create a `provinces` lookup (NL provinces, ES regions, etc.) mapped to cities
- Add `/trainers/region/{province-slug}` route and page
- Include in sitemap
- Links from city pages up to province, and province pages down to cities

### 5. Sitemap index split
- Split current monolithic sitemap into sub-sitemaps: `sitemap-static.xml`, `sitemap-trainers.xml`, `sitemap-locations.xml`, `sitemap-cities.xml`, `sitemap-blog.xml`
- Generate a `sitemap-index.xml` that references them all

## Recommended Priority

| Priority | Task | SEO Impact |
|----------|------|------------|
| 1 | Fix nearby cities internal linking | High |
| 2 | Translate city page content to all 5 languages | High |
| 3 | Fix breadcrumb language in structured data | Medium |
| 4 | Fix blog hreflang in sitemap | Medium |
| 5 | Add province/region pages | Medium-High |
| 6 | Sitemap index split | Low (nice-to-have) |

## Files to Change

- `src/pages/TrainersCity.tsx` — nearby cities, i18n, breadcrumb fix
- `src/i18n/locales/*/marketing.json` (all 5) — city page translation keys
- `supabase/functions/sitemap/index.ts` — blog hreflang fix, optional sitemap split
- `src/components/DomainRouter.tsx` — province route (if doing #5)
- New: `src/pages/TrainersProvince.tsx` (if doing #5)

