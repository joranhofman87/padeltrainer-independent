

# Full Technical SEO Audit — Scalability & Correctness

## Verdict: Solid foundation, but scaling requires changes in 4+ files per new page type

The core infrastructure (sitemap pagination, XML escaping, hreflang, Cloudflare Worker) is well-built. The main scalability problem is **fragmentation** — route/page definitions are scattered across 4-5 independent files with no shared source of truth.

---

## Scalability Assessment: "What happens when I add a new page?"

### Adding a new static page (e.g. `/faq`)
You currently need to update **4 files**:
1. `DomainRouter.tsx` — frontend route
2. `supabase/functions/sitemap/index.ts` — `staticPages` array (line 231)
3. `supabase/functions/render-page/index.ts` — `staticPages` object (line 342)
4. `public/llms.txt` — URL structure section

Miss any one = broken SEO for that page.

### Adding a new Sanity content type (e.g. "drills")
You need to update **3 files**:
1. Sitemap content handler — new GROQ query + `generateSanityEntries` call
2. Render-page — new regex route match block (~15 lines of copy-paste)
3. `public/llms.txt` — URL pattern documentation

### Adding a new country/province
Currently **hardcoded** in the sitemap (lines 398-412). Must manually add slugs.

---

## Issues Found

### 1. CRITICAL: Province pages have NO render-page handler
The sitemap includes `/trainers/region/:province` URLs, but `render-page/index.ts` has no match for this pattern. Bots hitting these pages get generic fallback meta tags — no localized title, no description mentioning the province name.

**Fix**: Add a regex route match for `/trainers/region/:slug` in render-page.

### 2. MODERATE: `llms.txt` references stale URL `/padel-level-test`
Line 113 of `public/llms.txt` lists `/{lang}/padel-level-test` but the actual route is `/{lang}/tools/padel-level-test`. AI crawlers get wrong URLs.

**Fix**: Update line 113 to `/tools/padel-level-test`.

### 3. MODERATE: Provinces still hardcoded — not data-driven
When you expand to Italy, Portugal, or other markets, someone must remember to edit the array in the edge function. This will be forgotten.

**Fix**: Query distinct provinces from the `locations` table (`province` column). Fall back to the hardcoded list only if the column doesn't exist.

### 4. LOW: `fetchAllRows` is duplicated across 3 edge functions
The exact same `fetchAllRows` helper exists in `sitemap/index.ts`, `llms-full-txt/index.ts`, and potentially others. Any bug fix must be applied 3 times.

**Impact**: Low for now (it works), but increases maintenance risk.

### 5. LOW: render-page `page()` helper hardcodes `x-default` to NL
Line 395: `<link rel="alternate" hreflang="x-default" href="${SITE_URL}/nl${urlPath}">`. This is consistent with the sitemap's approach, so it's correct — but worth noting that if you ever change your default language strategy, it's in yet another place.

---

## What's Working Well (No Changes Needed)

- **Sitemap pagination**: True server-side batching, handles 13k+ locations
- **XML escaping**: Consistent `escapeXml` applied everywhere
- **Hreflang**: Correct 5-language alternates + x-default on all sitemaps
- **Blog cross-linking**: Groups by `canonical_id` for translated articles
- **Cloudflare Worker**: All proxy routes correct (sitemap, content, provinces, locations, cities, llms-full.txt)
- **CI workflow**: Exact page counts, timeouts, retries, summary
- **robots.txt**: Clean disallow rules, crawl-delay for aggressive bots
- **llms-full-txt edge function**: Uses `fetchAllRows` for all entities, batches profile lookups
- **Cache headers**: 1-hour TTL on all edge function responses

---

## Recommended Plan

### Priority 1: Fix province pages in render-page
Add route handler for `/trainers/region/:slug` with localized meta tags.

### Priority 2: Fix stale URL in llms.txt
Change `/{lang}/padel-level-test` → `/{lang}/tools/padel-level-test`.

### Priority 3: Make provinces data-driven
Replace the hardcoded array in the sitemap function with a query to `SELECT DISTINCT province FROM locations WHERE is_active = true`.

---

## File Summary

| File | Change | Priority |
|---|---|---|
| `supabase/functions/render-page/index.ts` | Add `/trainers/region/:slug` route handler with localized meta | Critical |
| `public/llms.txt` | Fix `/padel-level-test` → `/tools/padel-level-test` | Moderate |
| `supabase/functions/sitemap/index.ts` | Make provinces data-driven from locations table | Moderate |

