

## Simplify Academy Dashboard Profile Views Card

### Problem

The Profile Views card currently shows both 7-day and 30-day counts. It should only show 30-day views as the main number, matching the trainer dashboard style.

### Changes

**`src/pages/academy/AcademyDashboard.tsx`**

1. Update the stats state to remove `viewsLast7Days` and keep only `viewsLast30Days`
2. Change the card to display `viewsLast30Days` as the main number
3. Replace the subtitle text with a simple "Last 30 days" label (matching trainer dashboard)

**`src/lib/academy.ts`** (if needed)
- May simplify `getAcademyViewStats` to only return 30-day count, but will keep backward compatible

### Result

The card will show:
- "Profile Views" label with eye icon
- The 30-day count as the large number
- "Last 30 days" as subtitle text

### Files to modify
- `src/pages/academy/AcademyDashboard.tsx` (update card display and stats state)

