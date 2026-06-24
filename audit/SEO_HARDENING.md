# Technical SEO hardening — bot-prerender status codes + post-Lovable cleanup

After the Lovable→Vercel migration, GSC metrics dropped. Root cause for the crawl/indexing
instability: the Cloudflare bot-prerender worker served a **generic 200 homepage** (canonical
`https://padeltrainer.ai`) whenever render-page returned non-OK — including a genuine 404. To
Googlebot that reads as soft-404s + duplicate homepage canonicals across every failed URL.

## What changed (in this repo)

### 1. Cloudflare worker — `docs/cloudflare-worker.js` (the core fix)
The worker no longer returns a 200 homepage for any failed render. Instead:
- **render-page 404/410 → passed through as a real 404/410** (with `X-Robots-Tag: noindex`).
  render-page already produces a proper Not-Found document; the worker now relays its status +
  body instead of discarding it. (A 404 does not trip the circuit breaker.)
- **render-page 5xx/429 or a network error → `503` + `Retry-After` + `noindex` + `no-store`**
  (`unavailableResponse()`), so crawlers retry later and never index a fallback or drop the real
  URL.
- **Bot rate-limited → `503 Retry-After: 30`** (was: 200 homepage).
- **Circuit breaker open → `503 Retry-After: 300`** (was: 200 homepage).
- The old `STATIC_FALLBACK_HTML` (200, canonical→home) is **deleted**. The only fallback is the
  noindex 503 page, which carries **no canonical**. Bad responses are never cached as valid pages
  (`no-store` for 503; the 404 is cached briefly but not under the prerender cache key).
- Deploy-doc env examples updated off the retired `ppkbhd`/`lovable.app` values to the current
  `ficwbdrzefmblkbkomzw` project + the Vercel origin.

### 2. render-page — `supabase/functions/render-page/index.ts`
- The 404 fallback page now emits `<meta name="robots" content="noindex">` (defense-in-depth
  alongside the 404 status). render-page already returned the correct 404 status — verified.

### 3. Production SEO smoke test — `e2e/seo-smoke.spec.ts` + `.github/workflows/seo-smoke.yml`
Opt-in Playwright test (`SEO_SMOKE_BASE_URL`, read-only GETs as Googlebot) that asserts, against
the live site:
- a nonexistent public URL returns **404** (not a 200 soft-404), not served by the fallback;
- the homepage + **sampled live sitemap URLs** are real prerenders with a non-empty `<title>`, a
  **canonical that matches the requested page** (not a generic homepage canonical), and hreflang;
- `x-rendered-by` is never `padeltrainer-static-fallback` / `-unavailable` for valid URLs.
Paced under the worker's bot rate limit. The GH workflow runs it on manual dispatch + weekly.

## Verified locally / against live (read-only, no side-effecting functions invoked)
- `node --check docs/cloudflare-worker.js` passes; `STATIC_FALLBACK_HTML` fully removed.
- `eslint` clean on the changed files.
- Live Googlebot probes confirmed the bug and the unchanged-good paths:
  - `/en/this-page-should-not-exist-…` → **HTTP 200, x-rendered-by: padeltrainer-static-fallback** (the bug, pre-deploy).
  - `/en/` → 200 prerender, canonical `https://padeltrainer.ai/en` (correct).
  - `padeltrainer.lovable.app/` and `/en/` → **HTTP 200** (live duplicate, no Vercel headers).
  - Human `padeltrainer.ai/en/` → served by **Vercel** (`x-vercel-cache`), so the worker origin is
    already Vercel — Lovable is NOT load-bearing.
- SEO smoke test run against prod: homepage + sampled sitemap URLs **pass**; the 404 test **fails**
  as expected (the worker fix isn't deployed yet — it goes green after deploy).
- `sitemap.yml` + `scripts/generate-sitemap.ts` already use `ficwbdrzefmblkbkomzw` — no change needed.

## ⚠️ Still needs deployment / config OUTSIDE the repo (owner)
1. **Deploy the updated Cloudflare worker** — paste `docs/cloudflare-worker.js` into the Worker in
   the Cloudflare dashboard (it is not deployed from this repo). Re-verify its env vars point at
   the `ficwb` project + the Vercel origin (not `ppkbhd`/`lovable.app`). **This is what makes the
   404 test pass.**
2. **Redeploy `render-page`**: `supabase functions deploy render-page --project-ref ficwbdrzefmblkbkomzw` (for the 404 noindex meta).
3. **Kill the old Lovable duplicate** — `https://padeltrainer.lovable.app` still serves 200s and
   competes as duplicate content. Since the worker origin is already Vercel, it's safe to: in the
   Lovable dashboard, unpublish/disconnect the deployment (preferred), or 301-redirect all
   `padeltrainer.lovable.app/*` → the equivalent `https://padeltrainer.ai/*`. Confirm with
   `curl -I https://padeltrainer.lovable.app/` afterwards (expect 404/410 or a 301).
4. **Re-validate** post-deploy: run the SEO smoke workflow (Actions → "SEO smoke (production)" →
   Run), or `SEO_SMOKE_BASE_URL=https://padeltrainer.ai npx playwright test e2e/seo-smoke.spec.ts`.
   All three tests should pass.

## Observations / follow-ups (not done here)
- **Bot rate limit is aggressive** — the worker throttles bot prerenders to ~2 requests / 10s per
  IP. That can throttle Googlebot itself and contribute to crawl issues; consider raising it.
- **Sitemap scale (~156k URLs, 6 langs)** — confirm every templated route is genuinely indexable
  and worth the crawl budget; the smoke test samples but does not exhaustively verify all.
- **Performance** (deprioritised, real): Lighthouse on `/en/` scored SEO 100 but **Performance 42**
  (LCP ~16.5s, FCP ~6.1s, TBT ~610ms). Crawl/indexing correctness first; perf is a separate task.
