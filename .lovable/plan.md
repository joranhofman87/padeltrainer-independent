
## Reminder
**Manual follow-up:** Redeploy `docs/cloudflare-worker.js` to Cloudflare (expanded bot allowlist + sitemap/llms proxy). This plan does not touch it.

## Goal
Validate everything shipped in Phases 1–3 and produce a fresh audit report you can cross-check with 3rd party tools (PageSpeed, Rich Results Test, Schema.org validator, Ahrefs/Screaming Frog, llms.txt validators, etc.).

## Validation steps

1. **Static assets (served from origin/preview)**
   - `public/robots.txt` — confirm sitemap reference + bot allowlist
   - `public/sitemap.xml` — confirm sitemap-index references children
   - `public/llms.txt` + `public/llms-full.txt` — confirm `Last updated` header present
   - `index.html` — confirm: early `<html lang>` script, font preload + swap pattern, `color-scheme` + `prefers-color-scheme` loader, no blocking Google Fonts link

2. **Edge functions (live)**
   - `render-page`: curl with Googlebot UA for representative routes
     - `/nl` (home) → expect localized title/desc, hreflang, BreadcrumbList + Organization JSON-LD
     - `/en/trainer/<slug>` → Person schema
     - `/en/padel/<slug>` → SportsActivityLocation schema
     - `/en/academies/<slug>` → EducationalOrganization schema
     - `/en/blog/<slug>` → Article schema
     - confirm breadcrumb includes Home (the empty-path fix)
   - `llms-full-txt`: curl and confirm dynamic `Last updated:` + `Generated:` headers
   - `sitemap`: spot-check `?type=index`, `?type=static`, one location page; confirm per-URL `lastmod`

3. **Marketing page schemas (SPA-rendered, but also covered by render-page)**
   - View source via render-page for: `Playground` (ItemList), `RedFlagQuiz` (Quiz), `ChallengeMode` + `RateMyCourt` (WebApplication), `Trainers` / `Academies` / `About` / `Coaches` / `CoachPage` / `Pricing` (Phase-1 schemas)

4. **Tests**
   - Run `src/i18n/seo-lengths.test.ts` (vitest) — confirm SEO length lint still green and check for stale KNOWN_LONG_KEYS warnings
   - Run `supabase/functions/render-page/index.test.ts` (deno) — confirm the existing render-page integration tests still pass after Phase-2 schema additions

5. **Audit report**
   - Write `/mnt/documents/seo-llm-audit-2026-05-10.md` summarizing per-check status (PASS/FAIL/WARN), with curl excerpts and links to 3rd-party validators:
     - https://search.google.com/test/rich-results (per representative URL)
     - https://validator.schema.org
     - https://pagespeed.web.dev
     - https://llmstxt.org / llms.txt validators
     - https://www.xml-sitemaps.com/validate-xml-sitemap.html
   - Include the Cloudflare worker redeploy reminder at the top.

## Out of scope
- No code edits in this loop (validation only)
- No Cloudflare worker redeploy (manual user action)
- No new SEO copy changes
