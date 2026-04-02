

# Fix rating display: 2 decimal places instead of 4

## Problem
Ratings are stored/displayed with 4 decimal places (e.g. `5.7100`) but the input only supports 2 decimal precision (rounds `5.7056` → `5.71`). The trailing zeros look broken.

## Changes

### `src/pages/admin/AdminPlayerRatings.tsx`

1. **Display ratings with 2 decimals** — change `entry.rating.toFixed(4)` to `entry.rating.toFixed(2)` (line ~290)

2. **Input step to 2 decimals** — change `step="0.0001"` to `step="0.01"` (line ~280)

3. **Current rating column** — already uses `.toFixed(1)`, keep as-is (that's the profile `skill_rating`)

One file, two small changes.

