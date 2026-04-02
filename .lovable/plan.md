

# Fix Chart Direction + Add Real Logo to Share Card

## Problems
1. **Chart is inverted for KNLTB** — currently, the `lowerIsBetter` logic flips the Y-axis so a rating drop (8.0→4.2) renders as an upward line. The user wants the natural plot: high values at top, low values at bottom, so the line goes **down** (which IS the improvement for KNLTB).
2. **Share card uses text "PADELTRAINER.AI" instead of the actual logo** — need to embed the real SVG logo.

## Changes

### 1. `src/lib/ratingShareCard.ts` — Fix chart direction + embed logo

**Chart fix**: Remove the `lowerIsBetter` Y-axis flip. Always plot naturally (high values at top, low at bottom):
```ts
// Line 79: change from conditional to always natural
const y = chartH - pad - t * (chartH - pad * 2);
```

**Logo**: Read `src/assets/logo-light.svg` content and embed it inline in the SVG markup (as an `<image>` element with a data URI or inline SVG paths), replacing the `<text>PADELTRAINER.AI</text>` placeholder at line 146.

### 2. `src/components/player/RatingHistoryChart.tsx` — Fix dashboard chart direction

Remove `reversed={lowerIsBetter}` from the Recharts `<YAxis>` (line 355). This makes the dashboard chart also show values naturally — high at top, low at bottom.

### 3. `src/components/player/RatingShareCard.tsx` — Fix chart direction

Same fix as the shared helper: remove the `lowerIsBetter` conditional in the Y coordinate calculation (line ~73). Always use `chartH - pad - t * (chartH - pad * 2)`.

### 4. `supabase/functions/rating-og-image/index.ts` — Align OG image

Apply the same natural Y-axis logic so the OG preview image matches.

## Files changed

| File | Change |
|------|--------|
| `src/lib/ratingShareCard.ts` | Remove Y-flip for lowerIsBetter, embed actual logo SVG |
| `src/components/player/RatingHistoryChart.tsx` | Remove `reversed={lowerIsBetter}` from YAxis |
| `src/components/player/RatingShareCard.tsx` | Remove Y-flip for lowerIsBetter |
| `supabase/functions/rating-og-image/index.ts` | Align chart direction |

