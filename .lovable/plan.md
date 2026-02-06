
# Fix Player Dashboard Links to Trainers

## Problems Identified

1. **"Find Trainers" and "View All" links point to wrong domain**: The player dashboard (on `app.padeltrainer.ai`) uses `localizePath('/trainers')` which produces `/nl/trainers`. This route doesn't exist on the app domain -- it's a marketing-site-only route under `/:lang/trainers`.

2. **No trainers shown**: When manually navigating to the correct marketing URL, trainers should appear (data exists in the database). The issue is the Trainers page is wrapped in `MarketingLayout` and designed for the marketing domain only.

3. **Dashboard loading freeze**: After visiting an invalid route on the app domain and pressing back, the page gets stuck. This is a side-effect of navigating away from the `PlayerLayout` -- the browser "back" may not cleanly re-mount the layout.

## Solution

All three issues stem from the same root cause: links from the player dashboard to the trainers page need to go to the **marketing domain**, not the app domain.

### File 1: `src/pages/PlayerDashboard.tsx`

Replace `localizePath('/trainers')` with `getMarketingUrl('trainers')` for links that should go to the marketing site. This applies to:

- **Line 466**: "Find Trainers" quick action card -- use `window.location.href = getMarketingUrl('trainers')` instead of `navigate(localizePath('/trainers'))`
- **Line 554**: "View All" button in Featured Trainers section -- same change
- **Line 444**: Followed trainer click -- use `window.location.href = getMarketingUrl('trainer/' + slug)` instead of `navigate(localizePath(...))`

Also remove the unused `localizePath` import if no other usage remains.

### File 2: `src/pages/PlayerDashboard.tsx` (same file)

The featured trainer cards (line 575) currently use `navigate('/book/${trainer.id}')` which is correct -- they stay on the app domain for booking. No change needed there.

## What This Fixes

| Issue | Fix |
|-------|-----|
| Wrong "Find Trainers" URL | Links to `padeltrainer.ai/nl/trainers` (marketing domain) |
| No trainers displayed | Trainers page loads on correct domain with MarketingLayout |
| Dashboard loading freeze | No more invalid route navigation; no broken back-button state |

## Technical Details

- `getMarketingUrl('trainers')` produces `https://padeltrainer.ai/nl/trainers` in production and `/nl/trainers` in development
- Uses `window.location.href` instead of `navigate()` because these are cross-domain navigations
- The default language parameter in `getMarketingUrl` is `'nl'` which matches the current setup
- In development mode (Lovable preview), both domains are served together so relative paths work fine
