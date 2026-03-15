

## Technical SEO Audit -- Issues Found

After a thorough review, the foundation is strong (pre-rendering, hreflang, structured data, sitemap index). However, I found **5 issues** worth fixing, ranging from critical to minor.

---

### Issue 1: `render-page` only emits hreflang for 2 languages instead of 5 (Critical)

The `htmlDoc()` helper in `render-page/index.ts` (lines 163-164) hardcodes only two hreflang alternates:

```text
const altLang = opts.lang === 'nl' ? 'en' : 'nl';
```

This means bots see only **2 hreflang tags** (current + one alternate + x-default) instead of all 5 languages. The client-side `<SEO>` component correctly emits all 5. This mismatch means Google sees inconsistent hreflang signals between bot-rendered HTML and SPA-rendered HTML.

**Fix:** Update `htmlDoc()` to loop over all 5 languages, matching the client-side `<SEO>` component behavior.

---

### Issue 2: `og:locale` only handles 2 of 5 languages (Medium)

In `SEO.tsx` line 81:
```tsx
<meta property="og:locale" content={currentLang === 'nl' ? 'nl_NL' : 'en_US'} />
```

Spanish, German, and French pages all get `en_US` as their locale. Should map to `es_ES`, `de_DE`, `fr_FR`.

Also, `og:locale:alternate` only lists one alternate instead of all supported locales.

**Fix:** Add a locale map and emit all alternates.

---

### Issue 3: `llms.txt` is outdated -- only lists 2 languages, missing content sections (Low-Medium)

The `public/llms.txt` only references EN and NL, and is missing entire content verticals (strokes, rules, coaches, video tips, learn, topics). The `robots.txt` references `llms-full.txt` but no such static file exists (it's an edge function URL with a Supabase domain visible in the file).

**Fix:** Update `llms.txt` to reflect all 5 languages and all content types. Change the `llms-full.txt` reference to use the public domain.

---

### Issue 4: Static `sitemap.xml` in `public/` (181K lines) vs dynamic sitemap index (Low)

There's a massive `public/sitemap.xml` (181,803 lines) that appears to be a pre-generated snapshot. The `robots.txt` points to `https://padeltrainer.ai/sitemap.xml`. If the Cloudflare Worker or hosting serves this static file instead of the dynamic edge function, Google may be crawling a stale sitemap. The dynamic sitemap index architecture exists but may not be what Google actually hits.

**Fix:** Verify that the live `sitemap.xml` URL resolves to the dynamic edge function, not this static file. If the static file is a cache artifact from the GitHub Action, that's fine -- just confirm it's being refreshed regularly.

---

### Issue 5: `render-page` missing `og:locale` entirely (Low)

The `htmlDoc()` helper in render-page emits OG tags but no `og:locale`. Less critical since the `<html lang>` is set, but it's a gap vs the client-side rendering.

**Fix:** Add `og:locale` to `htmlDoc()`.

---

### Proposed Changes

| File | Change |
|------|--------|
| `supabase/functions/render-page/index.ts` | Fix `htmlDoc()`: emit all 5 hreflang alternates + add `og:locale` |
| `src/components/SEO.tsx` | Fix `og:locale` mapping for es/de/fr, emit all `og:locale:alternate` tags |
| `public/llms.txt` | Update to include all 5 languages, all content verticals, fix `llms-full.txt` URL |

The sitemap.xml question (issue 4) is an infrastructure verification -- not a code change.

