
# Fix the rating download properly

## Root cause
The previous fix only replaced the chart drawing inside `RatingShareCard`, but the export still depends on `html-to-image` capturing an off-screen DOM node (`position: absolute; left: -9999`). The latest screenshot is consistent with a Safari/iOS-style failure where the capture returns only the background and drops the rest of the content.

So the real issue is no longer the chart library. It is the export strategy.

## Best fix
Stop using DOM screenshot capture for the downloadable share image.

Instead, generate the share card as a deterministic image payload:
- build the card from the rating data as **SVG markup**
- convert that SVG to a PNG blob in the browser for download/share
- reuse the same card layout logic for the public preview / OG image as much as possible

This is much more reliable for:
- iPhone / Safari
- WhatsApp sharing
- hidden/off-screen rendering
- consistent branding output

## Changes

### 1. Replace `html-to-image` export in `src/components/player/RatingHistoryChart.tsx`
Remove the `toPng`-based `captureShareCard()` flow and replace it with:
- `buildRatingShareSvg(...)`
- `svgToPngBlob(...)`
- download/share from that PNG blob

This keeps the buttons the same, but changes the engine behind them.

### 2. Refactor `src/components/player/RatingShareCard.tsx`
Use this file as the visual/source-of-truth for the share card content, but move the reusable logic out so it can power SVG generation too:
- rating stats
- improvement text
- best rating
- badges
- chart point generation
- date labels
- colors/layout constants

Then either:
- keep `RatingShareCard.tsx` only for on-screen preview and export from shared helpers, or
- convert it into a pure SVG-rendering component

### 3. Add a shared generator module
Create a helper like:
- `src/lib/ratingShareCard.ts`

It should expose:
- normalized share-card data builder
- chart point builder
- SVG string generator for 1080x1350 export

This avoids duplicating logic between:
- player download/share
- public rating page
- OG image function

### 4. Update the OG/public rendering path for consistency
`supabase/functions/rating-og-image/index.ts` already builds SVG manually. Align its logic and copy with the new shared design so:
- downloaded image
- WhatsApp preview image
- public share page
all tell the same visual story

The OG image can stay separate in the function, but it should mirror:
- stat labels
- celebration logic
- chart direction
- best/current/start handling

### 5. Optional cleanup on public page
`src/pages/marketing/PublicRatingCard.tsx` still uses Recharts. That page is fine for browser rendering, but if the goal is visual consistency, switch it to the same chart style/logic as the export card.

Not required for the bug fix, but recommended.

## Files to update

| File | Change |
|------|--------|
| `src/components/player/RatingHistoryChart.tsx` | Replace `html-to-image` export with SVG→PNG export |
| `src/components/player/RatingShareCard.tsx` | Refactor to share layout/data logic or render pure SVG |
| `src/lib/ratingShareCard.ts` | New shared helper for share-card data + SVG generation |
| `supabase/functions/rating-og-image/index.ts` | Align visual/data logic with the new export |
| `src/pages/marketing/PublicRatingCard.tsx` | Optional consistency cleanup |

## Why this is the right approach
This fixes the actual weak point instead of patching around it again.

`html-to-image` on a hidden DOM card is fragile. A generated SVG/PNG export is:
- more reliable
- faster
- easier to make pixel-perfect
- better for SEO/share consistency because the same design can drive OG previews too

## Technical details
```text
Current:
hidden div -> html-to-image -> png
              fragile on Safari / off-screen capture

Proposed:
rating data -> SVG string -> PNG blob -> download/share
               deterministic and browser-safe
```

Implementation direction:
```text
1. Build share-card data from history
2. Generate SVG string for 1080x1350
3. Create Blob("image/svg+xml")
4. Draw onto canvas/ImageBitmap
5. Export PNG blob
6. Use same blob for Download + Web Share API
```
