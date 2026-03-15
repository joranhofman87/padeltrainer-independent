

## Audit: What Still Blocks Ranking

After reviewing the codebase, the sitemap and client-side routing are in good shape. There is **one critical gap** and a few smaller items:

### Critical: Pre-rendering missing for `/topics` routes

The `render-page` edge function (which serves HTML to search engine bots via Cloudflare) has **no handler for `/topics` or `/topics/:slug`**. This means Googlebot and other crawlers hitting topic pages get the generic SPA fallback — no title, no description, no structured data, no content. These pages effectively **cannot rank**.

The same edge function correctly handles `/learn`, `/learn/:slug`, `/blog/:slug`, `/padel-rules/:slug`, etc. — but topic routes were never added.

### Fix needed

**`supabase/functions/render-page/index.ts`** — Add two route handlers:

1. `/topics` — static page render with title "Padel Topics" and description
2. `/topics/:slug` — fetch topic from Sanity by slug, render with proper `<title>`, meta description, structured data, and content body (same pattern as `renderSanityArticle` for `learningArticle`)

This is a straightforward addition following the existing pattern in the file (lines 103-110 show the `/learn` equivalent).

### Secondary items (nice-to-have, not blocking)

- **Cloudflare Worker**: The exclusion-based bot detection logic should already forward `/topics/*` since it's not in `/app/*`. No change needed there — but worth verifying after deploy.
- **`llms.txt`**: Referenced in `robots.txt` but no file exists in the repo. Not a ranking blocker, but a missed opportunity for AI search visibility.

### Summary

| Item | Status | Impact |
|------|--------|--------|
| Sitemap includes topics | Done | - |
| Client-side routing works | Done | - |
| SEO metadata on client | Done | - |
| Structured data on client | Done | - |
| **Bot pre-rendering for /topics** | **Missing** | **Critical** |
| llms.txt file | Missing | Low |

### Plan

1. Add `/topics` static page handler in render-page edge function
2. Add `/topics/:slug` dynamic handler that fetches from Sanity and renders full HTML with meta tags and structured data
3. Follow the exact same `renderSanityArticle` pattern already used for other content types

This is a focused change to one file (~30 lines of new code).

