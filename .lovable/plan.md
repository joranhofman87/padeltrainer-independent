

# Technical SEO Audit: Sitemap, Robots.txt & LLMs.txt

## Overall Status: Mostly Solid — 7 Issues Found

---

## ROBOTS.TXT

### Issue 1: MODERATE — Missing Disallow for `/app` variants
Currently `Disallow: /app/` only blocks paths with a trailing slash. The path `/app` itself (without slash) is not blocked. Also, authenticated pages like `/*/settings` or `/*/dashboard` are not explicitly blocked — though they redirect anyway, it's cleaner to block them.

**Fix**: Add `Disallow: /app` (without trailing slash).

### Issue 2: LOW — No Crawl-delay directive
Not critical, but for aggressive bots like AhrefsBot and SemrushBot, a `Crawl-delay: 2` can prevent excessive crawling of your 65,000+ URL site.

**Fix**: Add bot-specific crawl-delay rules.

### Issue 3: PASS — Sitemap reference is correct
Points to `https://padeltrainer.ai/sitemap.xml` — correct.

---

## SITEMAP

### Issue 4: CRITICAL — `type=locations` fetches ALL rows on every page request
The current code fetches all ~13,000 locations into memory for every single page request (`fetchAllRows`), then slices. With 6 page requests during CI, that's 6 × 13,000 row fetches. This is wasteful and will cause timeouts as the dataset grows.

**Fix**: Implement true server-side pagination — fetch only the rows for the requested page using batched `.range()` calls within the page window (e.g., for page 2: rows 2500–4999, fetched in 1000-row batches).

### Issue 5: CRITICAL — `type=cities` also fetches ALL locations on every page request
Same issue — all locations are fetched just to extract unique city names, then sliced. This runs 3 times (3 city pages).

**Fix**: Same approach — or cache the city list in-memory within the function invocation and reuse.

### Issue 6: MODERATE — Provinces list is hardcoded and incomplete
The provinces sitemap contains a static list of 23 provinces (12 NL, 4 BE, 4 ES, 3 DE). As you expand to France and other countries, this will silently miss new provinces. There's no French province despite FR being a supported language.

**Fix**: Either make this data-driven (query distinct provinces from locations table) or add a comment/reminder to update when expanding. At minimum, add French provinces.

### PASS — XML escaping is in place
The `escapeXml` helper correctly handles `&`, `<`, `>`, `"`, `'`.

### PASS — Hreflang implementation is correct
All 5 languages get proper `xhtml:link` alternates with `x-default` pointing to NL.

### PASS — Blog hreflang groups by `canonical_id`
Translated articles correctly cross-reference each other.

### PASS — Workflow uses exact page counts from sitemap index
No more infinite loop risk.

---

## LLMs.txt

### PASS — `public/llms.txt` is comprehensive
Covers all entity types, URL patterns, languages, key pages.

### Issue 7: MODERATE — `public/llms-full.txt` is a static snapshot, not the dynamic edge function
You have both:
- `public/llms-full.txt` — a static file committed to the repo (stale, dated 2026-04-07)
- `supabase/functions/llms-full-txt/` — a dynamic edge function that queries live data

The `robots.txt` points to `https://padeltrainer.ai/llms-full.txt`, which serves the **static file** from Lovable's origin. The dynamic edge function is never called because:
1. The Cloudflare worker's `shouldPrerender` skips `.txt` files
2. There's no proxy route for `/llms-full.txt` to the edge function

So AI crawlers get stale data with truncated lists (1,000 row limit on trainers, locations, academies).

**Fix**: Either:
- **Option A**: Add a Cloudflare worker route to proxy `/llms-full.txt` to the edge function (best — always fresh)
- **Option B**: Add `llms-full.txt` regeneration to the weekly GitHub Actions workflow (same approach as sitemaps)

### PASS — `llms-full-txt` edge function handles >1000 rows for profiles
It batches profile fetches in groups of 1000. However, the initial trainer/location/academy queries still use single `.select()` calls (1000-row limit). This is the same bug we fixed in the sitemap.

### Sub-issue within Issue 7: `llms-full-txt` edge function has 1000-row limits
The three main queries (trainers, locations, academies) are single queries without pagination — they'll silently truncate at 1000 rows.

---

## Cloudflare Worker

### PASS — All sitemap routes are mapped
Including the recently added `sitemap-content.xml`.

### PASS — Fallback HTML exists for circuit breaker scenarios

### Issue (previously noted): Static fallback mentions "Netherlands"
Line 97: `"PadelTrainer.ai connects players with the best coaches in the Netherlands."` — contradicts the global positioning branding guideline.

---

## Recommended Changes

| File | Change | Priority |
|---|---|---|
| `public/robots.txt` | Add `Disallow: /app`, add crawl-delay for aggressive bots | Moderate |
| `supabase/functions/sitemap/index.ts` | Implement true paginated fetch for locations (fetch only the page window, not all rows) | Critical |
| `supabase/functions/llms-full-txt/index.ts` | Replace single queries with `fetchAllRows` pattern for trainers, locations, academies | Moderate |
| `docs/cloudflare-worker.js` | Add proxy route for `/llms-full.txt` to edge function; fix "Netherlands" in fallback HTML | Moderate |
| `supabase/functions/sitemap/index.ts` | Consider making provinces data-driven or add French provinces | Low |

