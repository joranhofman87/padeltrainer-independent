

# Growth/SEO Manager Audit — Ranking Faster with Existing Content

## Executive Summary

Your technical SEO foundation is strong — structured data, hreflang, sitemap index, bot pre-rendering, `llms.txt`. But there are **5 actionable gaps** that are slowing down how fast Google discovers, understands, and ranks your content. These are ordered by expected impact on organic growth velocity.

---

## 1. `llms.txt` has wrong URLs — confusing AI crawlers

**Problem**: `public/llms.txt` references `/strokes` and `/strokes/:slug` (lines 65, 90-91) but your actual routes are `/padel-strokes` and `/padel-strokes/:slug`. Any AI crawler following these links gets 404s.

**Fix**: Update `llms.txt` to use `/padel-strokes` everywhere. Also add missing content types: Racket Finder, Gear/Rackets, Padel Coaches, Topics.

---

## 2. VideoTipPage missing translations + hreflang

**Problem**: `VideoTipPage.tsx` never calls `getTranslations()` and doesn't pass `translations`/`pathPrefix` to `<SEO>`. This means all language versions of a video tip page have identical hreflang tags pointing to the same slug — Google may deduplicate or pick the wrong version.

**Fix**: Add translation fetching and pass `translations={translationsList}` + `pathPrefix="video-tips"` to `<SEO>`, matching the pattern already used on Rules, Strokes, Learning, Coach, and Blog pages.

---

## 3. Sanity sitemap entries missing `lastmod` from CMS

**Problem**: The `generateSanityEntries()` function in the sitemap edge function hardcodes `lastmod` to `today` for all Sanity content. This means Google sees every Sanity page as "just updated" every day, which dilutes the crawl budget signal. Google prioritizes crawling pages with genuinely recent `lastmod` changes.

**Fix**: Fetch `_updatedAt` from each Sanity document in the GROQ queries and use it as `lastmod`. This tells Google which content actually changed, so it recrawls updated pages faster and doesn't waste budget on stale ones.

---

## 4. Homepage `SearchAction` URL uses hardcoded `/en/`

**Problem**: The `SearchAction` target in `Home.tsx` (line 46) is `https://padeltrainer.ai/en/trainers?search={search_term}` — always English regardless of current language. Google may present the English search result to Dutch users.

**Fix**: Use `currentLang` from `useParams` or `i18n.language` to build the URL dynamically: `https://padeltrainer.ai/${currentLang}/trainers?search={search_term}`.

---

## 5. `render-page` edge function — video tips, coaches, rackets still English-only

**Problem**: The `render-page` function has proper NL/ES/DE/FR translations for blog, learn, rules, and strokes pages. But video tips (line 245-251), coaches (line 234-241), and rackets (line 264-271) still serve English-only meta regardless of language prefix. When Googlebot crawls `/nl/video-tips/bandeja-uitleg`, it gets "Watch: Bandeja Uitleg" in English.

**Fix**: Add localized templates for these 3 route groups, matching the pattern used for blog/learn/rules/strokes.

---

## What's Already Working Well (No Changes Needed)

- All 4 Sanity content types now pass `translations`/`pathPrefix` to SEO (Rules, Strokes, Learning, Coaches)
- Article schemas with `mainEntityOfPage`, `image`, `url` on all article pages
- `VideoObject` JSON-LD on video tip pages
- `SportsClub` with `geo`, `aggregateRating`, `telephone`, `openingHours` on locations
- `BreadcrumbList` JSON-LD on all content pages
- Sitemap index with paginated sub-sitemaps + Sanity hreflang groups
- `FAQPage` schemas on city pages, rules overview, racket finder
- `robots.txt` blocking app/pay/register/auth routes
- Internal linking via related content sections (Related Rules, Related Strokes, Related Guides)
- Topic cluster architecture with pillar pages

---

## File Summary

| File | Change |
|------|--------|
| `public/llms.txt` | Fix `/strokes` → `/padel-strokes`; add missing content type URLs |
| `src/pages/marketing/VideoTipPage.tsx` | Add `getTranslations()` + pass `translations`/`pathPrefix="video-tips"` to SEO |
| `supabase/functions/sitemap/index.ts` | Fetch `_updatedAt` from Sanity; use real dates instead of `today` |
| `src/pages/marketing/Home.tsx` | Make `SearchAction` URL use current language |
| `supabase/functions/render-page/index.ts` | Add NL/ES/DE/FR meta for video tips, coaches, rackets routes |

