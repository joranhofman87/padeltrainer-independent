

# Full SEO & LLM Audit — PadelTrainer.ai

## Overall Assessment: Strong Foundation, 8 Remaining Gaps

Your SEO implementation is already well above average — structured data on all major page types, hreflang tags, sitemap index with pagination, `render-page` bot pre-rendering, `llms.txt` + `llms-full.txt`, OG/Twitter cards everywhere. Here are the remaining gaps ranked by impact.

---

## CRITICAL — Priority 1: Translated hreflang slugs still missing on 4 content types

**Status**: This was approved in the last plan but **never implemented**. Only `BlogPost.tsx` passes `translations` + `pathPrefix` to `<SEO>`. The other 4 Sanity content types that fetch translations still generate incorrect hreflang tags (same slug across all languages instead of actual translated slugs).

**Impact**: Google may index the wrong language version or treat pages as duplicates. This is your biggest multilingual SEO issue.

**Fix**: Pass `translations={translationsList}` and `pathPrefix` to `<SEO>` on each page:

| Page | pathPrefix |
|------|-----------|
| `RulesPage.tsx` | `padel-rules` |
| `StrokePage.tsx` | `padel-strokes` |
| `LearningArticlePage.tsx` | `learn` |
| `CoachPage.tsx` | `padel-coaches` |

---

## Priority 2: Trainer profile structured data — missing `/{lang}/` prefix

The `TrainerProfile.tsx` page builds its `url` as `https://padeltrainer.ai/trainer/${trainerSlug}` — missing the language segment. Should be `https://padeltrainer.ai/${currentLang}/trainer/${trainerSlug}`. Same issue in the breadcrumb `item` URLs (they already use `currentLang` correctly, but the Person schema `url` does not).

**Fix**: One-line change in `TrainerProfile.tsx` line ~322.

---

## Priority 3: Homepage Organization schema — empty `sameAs` array

`Home.tsx` has `"sameAs": []` in the Organization schema. Either populate it with your actual social profiles (LinkedIn, Instagram, etc.) or remove the property entirely. An empty array signals "no social presence" to Google.

**Fix**: Add your social media URLs or remove the empty array.

---

## Priority 4: Homepage SearchAction URL missing `/{lang}/` prefix

The WebSite schema `SearchAction` target is `https://padeltrainer.ai/trainers?search={search_term}` — missing the language prefix. Should include `/{lang}/` or use `/en/` as default.

**Fix**: Update the target URL in `Home.tsx`.

---

## Priority 5: `render-page` edge function — all text is English-only

The `render-page` function serves the same English meta descriptions regardless of language prefix. For example, a Dutch bot hitting `/nl/blog/mijn-artikel` gets "Read 'Mijn Artikel' on the PadelTrainer.ai blog" — English text with a Dutch slug. This confuses language signals for Google.

**Fix**: Add basic Dutch translations for the most common route templates (homepage is already bilingual, but blog/learn/rules/locations are not). Even just translating "Read", "Find", "Discover", "Book" for NL/ES/DE/FR would help significantly.

---

## Priority 6: Missing `racket-finder` and `founding-trainers` in sitemap

The sitemap `staticPages` array includes `/padel-coaches`, `/video-tips`, `/learn`, etc. but is missing `/racket-finder` and `/founding-trainers`. These pages exist in the `render-page` function but aren't being indexed via the sitemap.

**Fix**: Add both paths to the `staticPages` array in the sitemap edge function.

---

## Priority 7: `llms-full.txt` — stale "Generated" date and missing academies URL pattern

The file says "Generated: 2025-04-07" (a year ago). The `Academies` entity type is described but has no URL pattern section like the others. Also missing: the racket-finder tool URL and the padel level test tool URL.

**Fix**: Update the date, add academy URL patterns, add tool URLs.

---

## Priority 8: `robots.txt` — missing `Disallow` for `/app/auth` and other app routes

Currently `Disallow: /app/` blocks the app. But auth callback pages like `/app/auth` could still be crawled if linked externally. Also, the `Disallow: /*/pay/` pattern might not catch all payment routes. Consider adding explicit blocks for registration form routes (`/*/register/*`) to avoid thin content indexing.

**Fix**: Minor additions to `robots.txt`.

---

## What's Already Good (no action needed)

- Article, BreadcrumbList, FAQPage, VideoObject, SportsClub, LocalBusiness, CollectionPage schemas all implemented
- `mainEntityOfPage`, `image`, `url`, `speakable`, `isPartOf` on blog posts
- `geo`, `aggregateRating`, `telephone`, `openingHours` on location pages
- Proper `x-default` pointing to Dutch
- Sitemap index with paginated sub-sitemaps + Sanity content with hreflang alternates
- `render-page` covers all route patterns
- OG article tags (`published_time`, `modified_time`, `author`) on article pages
- `WebSite` + `Organization` schemas on homepage
- `SearchAction` on homepage
- Bot pre-rendering via Cloudflare worker

---

## File Summary

| File | Change |
|------|--------|
| `src/pages/marketing/RulesPage.tsx` | Add `translations`/`pathPrefix="padel-rules"` to SEO |
| `src/pages/marketing/StrokePage.tsx` | Add `translations`/`pathPrefix="padel-strokes"` to SEO |
| `src/pages/marketing/LearningArticlePage.tsx` | Add `translations`/`pathPrefix="learn"` to SEO |
| `src/pages/marketing/CoachPage.tsx` | Add `translations`/`pathPrefix="padel-coaches"` to SEO |
| `src/pages/TrainerProfile.tsx` | Fix missing `/${lang}/` in Person schema `url` |
| `src/pages/marketing/Home.tsx` | Populate `sameAs` array; fix SearchAction URL |
| `supabase/functions/render-page/index.ts` | Add basic NL translations for common routes |
| `supabase/functions/sitemap/index.ts` | Add `/racket-finder` and `/founding-trainers` to static pages |
| `public/llms-full.txt` | Update date, add academy/tool URL patterns |
| `public/robots.txt` | Add `Disallow` for registration routes |

