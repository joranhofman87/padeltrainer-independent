

# Fix: Login fails on padeltrainer.ai but works on www

## Root cause
The backend is overloaded. Evidence:
- The Supabase metadata query itself timed out during this session
- The `render-page` edge function logs show **dozens of boot/shutdown cycles per second** -- bots are hammering it continuously
- Each render-page invocation likely queries the database, saturating the connection pool
- Auth requests then get 503 "context deadline exceeded" because no DB connections are available

The reason `www` works intermittently is likely timing -- the backend has brief windows of availability between bot traffic spikes.

## Plan

### 1. Reduce render-page load (primary fix)
The Cloudflare Worker should **cache** bot-rendered pages instead of hitting the edge function on every request. Add `Cache-Control` headers and use Cloudflare's Cache API so repeated bot crawls of the same URL don't re-invoke the function.

In `docs/cloudflare-worker.js`:
- Use Cloudflare's `caches.default` to cache render-page responses for 1 hour
- Check cache before calling the edge function
- This alone should dramatically reduce backend load

### 2. Add rate limiting to render-page edge function
In `supabase/functions/render-page/index.ts`:
- Add a simple in-memory rate limiter or early-return for excessive requests
- Return cached/stale HTML when under pressure rather than querying DB

### 3. Frontend: add retry with backoff for auth 503s
In `src/lib/auth.ts`:
- When `signInWithEmail` gets a 503/retryable error, retry once after 2 seconds before showing the error
- This handles transient overload gracefully

## Files

| File | Change |
|------|--------|
| `docs/cloudflare-worker.js` | Add Cloudflare Cache API caching for render-page responses |
| `supabase/functions/render-page/index.ts` | Add basic rate limiting / early cache response |
| `src/lib/auth.ts` | Add single retry with 2s delay on 503 errors |

## Expected result
- Bot traffic no longer saturates the DB connection pool
- Auth endpoint becomes reliably available
- Login works consistently on both `padeltrainer.ai` and `www.padeltrainer.ai`

