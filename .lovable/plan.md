

# Emergency: Kill render-page DB queries to stop connection drain

## Situation after upgrade
- Instance upgraded: auth requests now succeed (200) but take 3-15 seconds
- render-page: **still 2-3 boot/shutdown cycles per second** — unchanged
- The Cloudflare Worker rate limiting is not stopping this because bots are likely hitting the edge function URL directly (ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/render-page), bypassing Cloudflare

## Plan

### 1. Make render-page zero-DB-cost (immediate relief)
Strip all database queries from `render-page`. Instead of fetching real data from the DB for every bot request, serve pre-built static meta tags for all paths. This instantly eliminates the connection pool drain.

The function will:
- Parse the URL path to determine page type
- Return appropriate static HTML with hardcoded OG tags per route pattern
- No Supabase client creation, no DB queries at all
- Keep the function working for SEO (bots still get structured HTML with titles/descriptions) but without any backend cost

### 2. Add auth token verification to render-page
Require the Supabase anon key in an Authorization header. The Cloudflare Worker already sends this. Direct bot hits without the key get rejected immediately with 401.

## Files

| File | Change |
|------|--------|
| `supabase/functions/render-page/index.ts` | Remove all DB queries; return static HTML based on URL pattern; add auth header check |

## Expected result
- render-page stops consuming DB connections entirely
- Auth and app queries get full connection pool access
- App becomes responsive immediately
- SEO still works (bots get reasonable meta tags, just not dynamic data)

