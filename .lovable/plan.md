

# SEO Optimization Audit — Remaining Gaps

Your blog pages are now well-optimized after the last round. Here's what's still missing across the rest of your Sanity-driven content pages.

---

## Priority 1 — Translated hreflang slugs missing on 4 content types

**Problem**: Only `BlogPost.tsx` passes `translations` + `pathPrefix` to the `<SEO>` component for proper hreflang with actual translated slugs. The other 4 Sanity content types that fetch translations (`RulesPage`, `StrokePage`, `LearningArticlePage`, `CoachPage`) all call `getTranslations()` but never pass the result to `<SEO>`. This means their hreflang tags use the same slug across all languages instead of the correct translated slug — bad for multilingual SEO.

**Fix**: Pass `translations={translationsList}` and `pathPrefix="padel-rules"` (etc.) to `<SEO>` on each page, matching the BlogPost pattern.

| Page | pathPrefix |
|------|-----------|
| `RulesPage.tsx` | `padel-rules` |
| `StrokePage.tsx` | `padel-strokes` |
| `LearningArticlePage.tsx` | `learn` |
| `CoachPage.tsx` | `padel-coaches` |

---

## Priority 2 — Missing `mainEntityOfPage`, `image`, `url` on Article schemas

**Problem**: Blog posts now have `mainEntityOfPage`, `image`, and `url` in their Article schema (from the last update). But Rules, Strokes, Learning Articles, and Coach pages are missing these — reducing Google rich result eligibility.

**Fix**: Add to each page's `structuredData` object:
```json
"url": "https://padeltrainer.ai/{lang}/{prefix}/{slug}",
"mainEntityOfPage": { "@type": "WebPage", "@id": "..." },
"image": "ogImage or default"
```

| Page | Currently missing |
|------|------------------|
| `RulesPage.tsx` | `url`, `mainEntityOfPage`, `image` |
| `StrokePage.tsx` | `url`, `mainEntityOfPage`, `image` |
| `LearningArticlePage.tsx` | `image` (has url + mainEntityOfPage via WebPage schema but not on Article) |
| `VideoTipPage.tsx` | No structured data at all — needs `VideoObject` JSON-LD |
| `CoachPage.tsx` | `url` is hardcoded without lang prefix |

---

## Priority 3 — VideoTipPage has no structured data

**Problem**: `VideoTipPage.tsx` renders no `structuredData` to `<SEO>`. Video pages are prime candidates for `VideoObject` schema, which enables rich video snippets in Google Search.

**Fix**: Add `VideoObject` JSON-LD with `name`, `description`, `thumbnailUrl`, `uploadDate`, `contentUrl`/`embedUrl`, and `duration` (if available).

---

## Priority 4 — Article OG tags missing on non-blog article pages

**Problem**: `publishedTime`, `modifiedTime`, and `author` OG tags are only passed on `BlogPost.tsx`. Rules and Learning Articles have `datePublished`/`dateModified` from Sanity but don't pass them to `<SEO>`.

**Fix**: Add `publishedTime`, `modifiedTime`, and `author` props to `<SEO>` on `RulesPage.tsx` and `LearningArticlePage.tsx`.

---

## Priority 5 — Racket listing page missing BreadcrumbList schema

**Problem**: `RacketListing.tsx` and `RacketDetail.tsx` render visual breadcrumbs but no `BreadcrumbList` JSON-LD. Google needs the structured data version.

**Fix**: Add `BreadcrumbList` schema to both pages.

---

## Priority 6 — `llms-full.txt` should include Sanity content types

**Problem**: The file was just created with a good structure but it's static. As you add more content in Sanity, the entity catalog becomes stale.

**Fix**: Add the new content types (Rackets/Gear, Coaches, Video Tips) to `llms-full.txt` with their URL patterns.

---

## File Summary

| File | Changes |
|------|---------|
| `src/pages/marketing/RulesPage.tsx` | Add `translations`/`pathPrefix` to SEO; add `url`, `mainEntityOfPage`, `image` to schema; add `publishedTime`/`modifiedTime` |
| `src/pages/marketing/StrokePage.tsx` | Add `translations`/`pathPrefix` to SEO; add `url`, `mainEntityOfPage`, `image` to schema |
| `src/pages/marketing/LearningArticlePage.tsx` | Add `translations`/`pathPrefix` to SEO; add `image` to Article schema; add `publishedTime`/`modifiedTime` |
| `src/pages/marketing/VideoTipPage.tsx` | Add `VideoObject` JSON-LD structured data |
| `src/pages/marketing/CoachPage.tsx` | Add `translations`/`pathPrefix` to SEO; fix hardcoded URL in schema |
| `src/pages/marketing/RacketListing.tsx` | Add `BreadcrumbList` JSON-LD |
| `src/pages/marketing/RacketDetail.tsx` | Add `BreadcrumbList` JSON-LD |
| `public/llms-full.txt` | Add Rackets, Coaches, Video Tips URL patterns |

