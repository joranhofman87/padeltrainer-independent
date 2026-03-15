

# Pre-Launch Technical Hardening

Your project is in excellent shape. The launch checklist, SEO, security, and observability are all solid. Below are the remaining items worth doing now so you never have to touch them later.

---

## 1. Vite Build Optimization — Manual Chunk Splitting

Currently Vite bundles everything into a single large JS chunk. Adding `manualChunks` splits vendor libraries (React, framer-motion, i18next, TanStack Query) into separate cacheable files. This improves repeat-visit performance since vendor code rarely changes.

**File:** `vite.config.ts`
- Add a `build.rollupOptions.output.manualChunks` config that separates:
  - `react` + `react-dom` + `react-router-dom` → `vendor-react`
  - `framer-motion` → `vendor-motion`
  - `i18next` + `react-i18next` → `vendor-i18n`
  - `@tanstack/react-query` → `vendor-query`
  - `@supabase/supabase-js` → `vendor-supabase`

---

## 2. Resource Hints in `index.html`

The Sanity CDN (`cdn.sanity.io`) is used on many marketing pages but has no preconnect. Adding it eliminates one DNS+TLS round-trip on first image/content load.

**File:** `index.html`
- Add `<link rel="preconnect" href="https://cdn.sanity.io" />`

---

## 3. SEO: Hreflang Coverage Update

The launch checklist says "Hreflang tags for EN/NL" but the SEO component actually generates hreflang for all 5 languages (EN, NL, ES, DE, FR). The checklist should be updated to reflect this — no code change needed, just accuracy.

Also, the `x-default` hreflang currently points to `/nl`. This is correct if Dutch is your primary market (which it is).

---

## 4. Static `public/sitemap.xml` Cleanup

The old static `public/sitemap.xml` file is now superseded by the dynamic Cloudflare Worker proxy. It should be replaced with a minimal redirect/pointer or removed entirely so there's no confusion if the Worker ever falls back to origin. Currently the Worker handles this, but the static file could serve stale data as a fallback.

**Action:** Replace `public/sitemap.xml` with a comment-only placeholder or remove it. The GitHub Action fallback (if still running) should be the only static copy.

---

## 5. Cache Headers on Cloudflare Worker

The Worker currently returns `Cache-Control: public, max-age=3600` for both sitemaps and pre-rendered HTML. Consider:
- Sitemaps: `max-age=3600` is fine (1 hour)
- Pre-rendered bot pages: `max-age=3600, s-maxage=86400` — let Cloudflare edge cache for 24h while bots see a 1h freshness window
- Static asset passthrough: Cloudflare should cache these longer. Add a Page Rule or Cache Rule for `*.js`, `*.css`, `*.woff2` with `max-age=31536000` (1 year, since Vite hashes filenames)

**Action:** Update Cloudflare Page Rules (dashboard only, no code change needed).

---

## 6. Launch Checklist Accuracy Update

Update `.lovable/LAUNCH_CHECKLIST.md`:
- Change "Hreflang tags for EN/NL" → "Hreflang tags for EN/NL/ES/DE/FR (all 5 languages)"
- Mark sitemap items as complete (dynamic sitemap is live via Cloudflare Worker)
- Note that `app.padeltrainer.ai` is no longer used (single-domain architecture)

---

## Summary

| Item | Type | Effort |
|------|------|--------|
| Vite manual chunks | Code change | Small |
| Sanity CDN preconnect | Code change | Trivial |
| Checklist accuracy | Doc update | Trivial |
| Static sitemap cleanup | File edit | Trivial |
| Cloudflare cache rules | Dashboard config | No code |

None of these are blocking, but items 1-2 directly improve Core Web Vitals (LCP, FCP) and items 4-5 prevent stale content issues post-launch. All changes are low-risk.

