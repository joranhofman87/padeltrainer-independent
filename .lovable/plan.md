

# Fix: App slowness and 500 errors caused by render-page bot traffic overload

## Root cause

The render-page edge function is **still being hammered at 3-4 requests per second** by bots, despite the Cloudflare Worker caching we just deployed. Each invocation creates a new Supabase client and runs DB queries, exhausting the connection pool (max 60 connections, with auth getting only 10).

This causes:
- **Statement timeouts** ("canceling statement due to statement timeout") for academy locations queries
- **500 errors** on subscription checks, profile fetches, and other edge functions
- **CORS errors** as a side effect — when edge functions return 500, CORS headers are sometimes dropped

The Cloudflare cache isn't effective because bots are likely hitting unique URLs (language variants, query params, different paths) that each miss the cache.

## Plan

### 1. Block bot traffic at the Cloudflare Worker level (highest impact)

The Cloudflare Worker currently forwards bot requests to render-page even on cache miss. We need to add **aggressive bot rate limiting at the Worker level** using Cloudflare's own infrastructure, and return a minimal static HTML fallback when the edge function is under pressure, instead of hitting the backend.

In `docs/cloudflare-worker.js`:
- Add a per-IP rate limiter using a simple Map (Cloudflare Workers have ~128MB memory)
- Limit bots to max 2 requests per 10 seconds per IP
- When rate limited, return a minimal static HTML page with basic meta tags instead of calling the edge function
- Add a global circuit breaker: if render-page returns 500/503/429 more than 3 times in 60 seconds, stop calling it entirely for 5 minutes and serve static fallback

### 2. Add response caching inside the render-page edge function itself

The in-memory rate limiter resets on every cold start (which happens every few seconds). Instead:

In `supabase/functions/render-page/index.ts`:
- Add `Cache-Control: public, max-age=3600` response headers so Supabase's own CDN can cache responses
- Return early with a minimal static HTML for unknown/unrecognized paths instead of querying the DB
- Reduce the scope — only query the DB for recognized marketing paths, return a generic meta tag page for everything else

### 3. Upgrade compute instance (user action)

The backend has a max pool of 60 connections and auth gets only 10. With this traffic volume, even fixing the bot issue may leave things tight. The user should consider upgrading their Lovable Cloud instance for more headroom.

## Expected result
- Bot traffic no longer saturates the DB connection pool
- Edge functions stop returning 500s
- CORS errors disappear (they were a symptom of 500s)
- App becomes responsive again

## Files

| File | Change |
|------|--------|
| `docs/cloudflare-worker.js` | Add per-IP bot rate limiting, global circuit breaker, static HTML fallback |
| `supabase/functions/render-page/index.ts` | Add Cache-Control headers, early return for unrecognized paths, remove in-memory rate limiter (moved to Worker) |

