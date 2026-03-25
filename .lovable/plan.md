

# Remove Quick Stats Card & Location from Academy Profile

## Changes in `src/pages/AcademyPublicProfile.tsx`

1. **Remove the stats card** (lines 299-313) — the `lg:w-[260px]` Card with verified/trainers/locations stats. Also remove the flex wrapper (`flex-col lg:flex-row`) since there's only one child left.

2. **Remove location prop** from `ProfileHeroCard` (line 283) — remove `location={locations[0]?.location?.city}` so "Udenhout" no longer shows.

3. **Clean up unused code** — remove `quickStats` array (lines 145-158), the `ProfileQuickStatsCard` import (unused already), and the `CheckCircle` / `Award` imports if no longer needed elsewhere.

## Result
The hero card renders full-width without the side stats card, and no city name appears under the academy name.

