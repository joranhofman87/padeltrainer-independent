

# Fix WhatsApp Share Preview for Rating Cards

## Two Problems

### 1. Web Share API leaks local file paths into the message
When `navigator.share()` is called with both `files` and `url`, WhatsApp concatenates the local file path with the URL in the message text — producing the garbled URL you see in the screenshot (`/Users/joranhofman/Library/...WebShare/rating-progress.png`).

**Fix**: When sharing with files, do NOT include the `url` parameter. Instead, put the URL inside the `text` field. This keeps the message clean.

### 2. OG preview shows generic PadelTrainer.ai metadata
WhatsApp's crawler fetches the URL to generate the preview. The `render-page` edge function correctly generates personalized OG tags for `/rating/:profileId`, but this only works if the `padeltrainer.ai` domain proxies crawler requests to the edge function. 

Since the app is an SPA hosted on Lovable, WhatsApp's crawler likely gets the SPA's `index.html` (with generic OG tags) instead of the server-rendered page. The `PublicRatingCard.tsx` page does set `<Helmet>` meta tags, but WhatsApp's crawler doesn't execute JavaScript — it only reads the initial HTML.

**Fix**: The `PublicRatingCard.tsx` page already has correct `<Helmet>` OG tags, but they won't work for crawlers. We need to ensure the published domain (`padeltrainer.ai`) routes `/rating/*` requests from crawlers through the `render-page` edge function. This likely requires a proxy/rewrite rule at the hosting level.

Since we can't control Lovable's hosting proxy, the pragmatic fix is to make the shareable URL point directly to the `render-page` edge function (which returns full HTML with OG tags), with a client-side redirect to the SPA for human visitors. Or: use the edge function URL as the canonical share URL.

Actually, looking at the existing setup — other marketing pages (trainers, locations, blog) presumably work with OG tags. Let me check if there's a Cloudflare Worker or similar proxy handling this.

## Changes

### `src/components/player/RatingHistoryChart.tsx`

1. **Fix `handleNativeShare`**: When sharing with files, omit `url` param and include the link in `text` instead:
```ts
await navigator.share({
  title: `${firstName}'s Padel Rating Progress`,
  text: `Check out my padel rating progress on PadelTrainer.ai! ${shareUrl}`,
  files: [file],
});
```

2. **Fix text-only share fallback**: Same pattern — URL in text, not as separate param (WhatsApp handles this better).

### `src/pages/marketing/PublicRatingCard.tsx`

The Helmet OG tags are already correct. The real issue is server-side rendering for crawlers — which the `render-page` function already handles. If the existing marketing pages' OG tags work (trainers, blog, etc.), then the rating page should too once deployed to production. The preview domain won't have this proxy.

No changes needed here if the production proxy is already configured for other routes.

## Summary

The main actionable fix is in `RatingHistoryChart.tsx` — stop passing both `files` and `url` to `navigator.share()`, which causes WhatsApp to mangle the URL with local file paths.

| File | Change |
|------|--------|
| `src/components/player/RatingHistoryChart.tsx` | Fix Web Share API call to avoid URL mangling |

