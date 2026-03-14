

## Simplify Cloudflare Worker — Remove Route Duplication

### Problem
The Cloudflare Worker duplicates all marketing route patterns from the `render-page` edge function. Every time a new page type is added, both files need updating — and the worker will inevitably be forgotten.

### Solution
Remove the `isMarketingPath` route matching from the worker entirely. Instead, use a simple **exclusion-based** approach: forward ALL bot GET requests to `render-page` unless they're for `/app/*` routes or static assets. The edge function already handles unknown routes gracefully via `renderFallback()`, so there's no downside.

### Changes to `docs/cloudflare-worker.js`

Replace the complex `isMarketingPath()` function (30+ regex patterns) with:

```javascript
function shouldPrerender(pathname) {
  // Never pre-render app routes
  if (pathname.startsWith('/app')) return false;
  
  // Never pre-render static assets
  if (pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|webp|avif|mp4|webm)$/)) return false;
  
  // Everything else: let render-page handle it (it has its own fallback)
  return true;
}
```

That's it. One file change. The `render-page` edge function already has all the routing logic and returns a sensible fallback for unknown paths. No more route duplication to maintain.

### Files to Modify
- `docs/cloudflare-worker.js` — replace `isMarketingPath()` with `shouldPrerender()`

**Note:** After this deploy, you'll still need to update the actual Cloudflare Worker in your dashboard with the new code. But from now on, the worker code is stable — you'll never need to touch it again when adding new pages.

