

# Connect City Pages to Sanity CMS — Implementation Plan

## Prompt Assessment: Ready to implement as-is

The uploaded prompt is accurate and well-aligned with the current `CityLanding.tsx` architecture. A few refinements:

### What the prompt gets right
- Correct graceful fallback pattern (Sanity content → template-generated content)
- Correct sections to replace (intro, FAQs, nearby cities, SEO meta, estimated clubs)
- Correct instruction to NOT touch clubs/trainers/lessons sections (those stay data-driven)
- Correct use of existing `PortableTextRenderer` for the intro field

### Small additions needed beyond the prompt

1. **Province in hero subtitle** — the prompt suggests showing province, but the hero subtitle currently comes from an i18n key (`cityLanding.heroSubtitle`). We should use province from Sanity when available but keep the i18n fallback.

2. **Nearby cities from Sanity vs database** — currently `nearbyCities` comes from `getCitiesWithTrainers()` (database query for cities with active trainers). The Sanity `nearbyCities` field contains just 3 city names. We should: use Sanity nearby cities when available, but **also** keep showing database-driven nearby cities below them (more = better for internal linking).

3. **`estimatedClubs` usage** — show Sanity's `estimatedClubs` in the hero stats ONLY when no real location data exists (`locations.length === 0`). When we have real data, real counts are always better.

4. **Italian templates in `cityContent.ts`** — still needed as fallback for Italian cities not yet in Sanity. The prompt doesn't mention this but it's required for completeness.

---

## Changes

### 1. Add GROQ queries to `src/lib/sanity.ts`

Add `CITY_PAGE_QUERY` and `ALL_CITY_SLUGS_QUERY` constants plus a `CityPage` TypeScript interface.

### 2. Update `src/pages/marketing/CityLanding.tsx`

- Import `sanityClient` and `CITY_PAGE_QUERY`
- Import `PortableTextRenderer` for intro rendering
- Add Sanity fetch to `fetchData()` alongside existing parallel queries
- Use Sanity data for: intro (Portable Text), FAQs, nearby cities, SEO meta, province subtitle, estimated clubs fallback
- Keep all existing club/trainer/lessons sections unchanged

### 3. Add Italian fallback templates to `src/lib/cityContent.ts`

Add `it` entries to `introTemplates`, `clubIntroTemplates`, `lessonsTemplates`, and FAQ generation so Italian cities without Sanity content still get reasonable text.

### 4. Update sitemap edge function

In `supabase/functions/sitemap/index.ts`, add a Sanity query for `cityPage` slugs to include in the cities sitemap alongside database-driven ones. This ensures all 66 Sanity cities appear even without location data.

### 5. Update render-page edge function

In `supabase/functions/render-page/index.ts`, fetch Sanity `cityPage` SEO fields for the `/padel/:city` route and use `seo.titleTag` / `seo.metaDescription` when available.

---

## File Summary

| File | Change |
|---|---|
| `src/lib/sanity.ts` | Add `CITY_PAGE_QUERY`, `ALL_CITY_SLUGS_QUERY`, `CityPage` type |
| `src/pages/marketing/CityLanding.tsx` | Fetch Sanity city content, use for intro/FAQs/nearby/SEO/province |
| `src/lib/cityContent.ts` | Add `it` fallback templates |
| `supabase/functions/sitemap/index.ts` | Query Sanity for city slugs to include in sitemap |
| `supabase/functions/render-page/index.ts` | Fetch Sanity SEO fields for city pages |

