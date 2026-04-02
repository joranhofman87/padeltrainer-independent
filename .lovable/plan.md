

# Fix: Downloaded share card is blank

## Root cause

`html-to-image` (`toPng`) cannot properly render Recharts SVG components when the container is positioned off-screen (`left: -9999`). Recharts relies on DOM measurements for rendering, so the chart never actually draws — resulting in a blank dark image.

## Fix

Replace the Recharts `<AreaChart>` in `RatingShareCard.tsx` with a **pure inline SVG** `<polyline>` + `<polygon>` (same approach as the `rating-og-image` edge function). This removes the Recharts dependency from the share card entirely, making it reliably capturable by `html-to-image`.

### `src/components/player/RatingShareCard.tsx`

1. Remove `AreaChart, Area, XAxis, YAxis` imports from recharts
2. Compute chart points manually from the history array:
   - Map ratings to x/y coordinates within a fixed viewBox (e.g. 920x300)
   - Respect `lowerIsBetter` for y-axis direction
3. Replace the Recharts chart with a simple inline `<svg>` containing:
   - A `<polygon>` for the gradient fill area
   - A `<polyline>` for the orange line
   - A `<linearGradient>` definition for the fill
   - Optional: a few tick labels on x-axis (first/last date) and y-axis (min/max rating)

This is the same pattern already used in `supabase/functions/rating-og-image/index.ts` — just ported to JSX.

## Files changed

| File | Change |
|------|--------|
| `src/components/player/RatingShareCard.tsx` | Replace Recharts with pure SVG polyline for reliable image capture |

