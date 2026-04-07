

# Technical SEO Recheck — Status Report

## Current State: 3 Remaining Issues (1 Critical, 2 Moderate)

Everything else from previous audits has been correctly fixed and is working.

---

## CRITICAL: Stale Committed Sitemap Files Have Wrong URLs

The **edge function** (`supabase/functions/sitemap/index.ts`) correctly uses `/tools/padel-level-test` (line 249). But the **committed sitemap file** at `public/sitemaps/sitemap-static.xml` still contains 5 URLs pointing to `/padel-level-test` (without `/tools/`). These were generated before the fix and haven't been regenerated since.

Similarly, `public/llms-full.txt` line 118 still references `/{lang}/padel-level-test` instead of `/{lang}/tools/padel-level-test`.

And `public/llms.txt` line 73 has `https://padeltrainer.ai/en/padel-level-test` (wrong) while line 113 correctly has `/{lang}/tools/padel-level-test` — inconsistent within the same file.

**Fix**: 
- `public/llms.txt` — update line 73 to use `/tools/padel-level-test`
- `public/llms-full.txt` — update line 118 to use `/tools/padel-level-test`
- The committed sitemap XML files will auto-fix on the next weekly CI run (or manual trigger)

---

## MODERATE: `public/llms.txt` Missing `/padel/:city` URL Pattern

The sitemap generates `/padel/:city` URLs (line 390 of sitemap function), the frontend has the route (`CityLanding`), and render-page handles it — but `llms.txt` doesn't document this URL pattern at all. AI crawlers won't know these pages exist.

**Fix**: Add `- /{lang}/padel/:city - City landing page with clubs, courts & coaches` to the URL Structure section of `public/llms.txt`.

---

## MODERATE: `public/llms.txt` Missing `/founding-trainers` and Province Pages

The URL Structure section in `llms.txt` is missing:
- `/{lang}/founding-trainers` — in the sitemap and render-page
- `/{lang}/trainers/region/:province` — in the sitemap and render-page but not documented for AI crawlers

**Fix**: Add both to the URL Structure section.

---

## Everything Else: PASS

| Component | Status |
|---|---|
| **robots.txt** | Correct — blocks `/app`, `/app/`, auth, settings, dashboard, pay, register. Crawl-delay set. Sitemap reference correct. |
| **Cloudflare Worker** | All proxy routes correct (sitemap index, static, content, provinces, locations-N, cities-N, llms-full.txt). Bot detection, rate limiting, circuit breaker all solid. |
| **Sitemap edge function** | True server-side pagination for locations. `fetchAllRows` for trainers/academies/blog/cities. Data-driven provinces with fallback. XML escaping. Correct hreflang with x-default → NL. |
| **Render-page** | All routes handled including `/padel/:city`, `/trainers/region/:slug`, `/tools/padel-level-test`. Localized meta for all 5 languages. |
| **SEO component** | Correct canonical, hreflang (with translated slug support), OG tags, Twitter cards, structured data. |
| **CI workflow** | Exact page counts from sitemap index, timeouts, retries, llms-full.txt regeneration. |

---

## Plan — Files to Change

| File | Change |
|---|---|
| `public/llms.txt` | Fix padel-level-test URL (line 73); add `/padel/:city`, `/founding-trainers`, `/trainers/region/:province` to URL Structure |
| `public/llms-full.txt` | Fix padel-level-test URL (line 118) |

Two small edits. No edge function or workflow changes needed.

