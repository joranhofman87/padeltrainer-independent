

# Fix: Sitemap Generation Taking 14+ Minutes

## Root Cause

The bottleneck is the `?type=static` edge function call. It makes **10 sequential/parallel external API calls** in a single invocation:
- 3 Supabase queries (trainers, academies, blog articles)
- 7 Sanity CMS queries (rules, strokes, coaches, video tips, learning articles, topics, products)

Edge Functions have a wall-clock timeout (~150s). If any Sanity query is slow or the function cold-starts, it can **time out silently** — causing `curl` to hang waiting for a response with no timeout set. The workflow has **zero curl timeouts**, so a failed/hung edge function call blocks the entire job indefinitely.

The `?type=index` call also fetches ALL locations just to count pagination — another heavy call.

## Fix — 2 Changes

### 1. Add curl timeouts to the workflow (`.github/workflows/sitemap.yml`)

Add `--max-time 120 --retry 2 --retry-delay 5` to every curl call. This ensures:
- No single call hangs longer than 2 minutes
- Failed calls get 2 retries with 5s delay
- Total worst case: ~15 min → ~8 min (with retries) or fails fast

### 2. Split the heavy `static` sitemap into `static` + `content` (`supabase/functions/sitemap/index.ts`)

Move the 7 Sanity CMS fetches into a new `?type=content` sub-sitemap. This splits one 10-query call into:
- `static`: 3 DB queries (trainers, academies, blog) — fast
- `content`: 7 Sanity queries (rules, strokes, coaches, etc.) — isolated

Add a corresponding step in the workflow and a new entry in the sitemap index.

## File Summary

| File | Change |
|---|---|
| `.github/workflows/sitemap.yml` | Add `--max-time 120 --retry 2` to all curl calls; add `content` sitemap fetch step |
| `supabase/functions/sitemap/index.ts` | Split `static` type: move Sanity fetches to new `content` type; add `content` to sitemap index |

