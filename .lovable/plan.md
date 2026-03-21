

# Validation of the SEO Prompt — What's Already Done vs. What's Missing

## Summary: Most of this is already implemented. The prompt is largely outdated.

Your project already has a sophisticated SEO setup. Here's the item-by-item breakdown:

---

## ✅ Already Implemented (No Action Needed)

| Item | Status |
|------|--------|
| **Pre-rendering / Bot SSR** | Cloudflare Worker detects bot user-agents and proxies to `render-page` edge function. All Sanity content types (blog, rules, strokes, coaches, video tips, learn, topics) are server-rendered for bots. |
| **Server-side meta tags** | The `render-page` function injects `<title>`, `<meta description>`, OG tags, hreflang tags, and JSON-LD structured data into the HTML for bots. |
| **react-helmet-async** | Already installed and used via the `SEO` component on every page. Handles title, description, canonical, hreflang, OG, Twitter, and structured data client-side. |
| **Hreflang tags** | Implemented both client-side (SEO component with translated slug support) and server-side (render-page). |
| **Sitemaps for Sanity content** | The `sitemap` edge function already queries Sanity for rules, strokes, coaches, video tips, learning articles, and topics — with proper hreflang alternates grouped by `translationOf`. |
| **Dynamic sitemaps via edge function** | Already using Option B (dynamic edge function), proxied through Cloudflare Worker. |
| **JSON-LD structured data** | Already on blog posts, stroke pages, and likely other content pages via the SEO component. |
| **Internal linking** | GROQ queries already fetch `relatedGuides`, `relatedRules`, `relatedStrokes`, `relatedVideoTips`, and `topics`. Related content sections are rendered on pages. |
| **Canonical URLs** | Set on every page via SEO component. |

---

## ⚠️ Two Small Gaps Found

### 1. Rackets/Products missing from sitemap AND render-page
The `sitemap` edge function does NOT include `product` (racket) documents from Sanity. The `render-page` function also has no route for `/gear/rackets/:slug`. This means Google cannot discover or properly index racket pages.

**Fix**: Add racket/product entries to the sitemap edge function and add a `/gear/rackets/:slug` route to the render-page edge function.

### 2. Rackets/Products missing from render-page bot SSR
Same gap — bots hitting `/en/gear/rackets/some-racket` get the fallback HTML, not proper meta tags.

---

## Recommended Action

Only fix the two racket/product gaps. Everything else the prompt suggests is redundant with your existing infrastructure.

### Changes needed:

**1. `supabase/functions/sitemap/index.ts`**
- Add a Sanity fetch for `product` documents (category "racket")
- Generate sitemap entries with `gear/rackets` path prefix, grouped by `translationOf`

**2. `supabase/functions/render-page/index.ts`**
- Add route matching for `/gear/rackets` listing page and `/gear/rackets/:slug` detail pages
- Use the existing `renderSanityArticle` function (or a similar pattern) to fetch product data from Sanity and inject proper meta tags, OG tags, and Product JSON-LD structured data

### Files to modify:
1. `supabase/functions/sitemap/index.ts` — Add product/racket Sanity fetch + entries
2. `supabase/functions/render-page/index.ts` — Add gear/rackets routes for bot rendering

