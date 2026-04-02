

# Fix Share Card: Logo Rendering + Language Consistency

## Problems
1. **Logo is cut off** — The SVG logo asset has `viewBox="0 660 1500 180"` which crops tightly. The `<image>` element in the share card uses `width="400" height="70"` which distorts the aspect ratio. The logo's native ratio is ~8.3:1, but 400:70 is ~5.7:1, causing clipping.
2. **Mixed Dutch/English** — "Padel Rating Journey" (English) alongside "Nu", "punten verbeterd", "jaar actief", "maanden progressie" (Dutch). Should be all Dutch.

## Changes

### `src/lib/ratingShareCard.ts`

1. **Fix logo dimensions**: Change `<image>` from `width="400" height="70"` to `width="600" height="72"` and re-center (`x` from 340 to 240). This matches the logo's ~8.3:1 aspect ratio so nothing gets clipped.

2. **Dutch-only text**:
   - Line 150: `"Padel Rating Journey"` → `"Padel Rating Voortgang"`
   - Line 155: `"Start"` → keep (same in Dutch)
   - Line 159: `"Nu"` → keep
   - Line 163: `"Best"` → `"Beste"`
   - Line 191: `"Track jouw rating op"` → keep
   - Line 30: `"All-time best rating!"` → `"All-time beste rating!"`

### `src/components/player/RatingShareCard.tsx`

Same language fixes:
- Line 19: `"All-time best rating!"` → `"All-time beste rating!"`
- Line 103: `"Padel Rating Journey"` → `"Padel Rating Voortgang"`

## Files changed

| File | Change |
|------|--------|
| `src/lib/ratingShareCard.ts` | Fix logo size/position, Dutch-only text |
| `src/components/player/RatingShareCard.tsx` | Dutch-only text |

