

# Lock Rating System on Registration Form to Cycle's Setting

## Problem
Players can currently change the rating system dropdown on the registration form (e.g. switch from KNLTB to Playtomic). The trainer/academy already sets the rating system when creating the cycle — the player should only fill in their rating value, not choose the system.

## Solution
In `CycleApplicationForm.tsx`, use the cycle's `settings.rating_system` as a fixed/read-only value instead of showing a selectable dropdown.

## Changes

### `src/components/cycles/CycleApplicationForm.tsx`

1. **Default `rating_system` from cycle settings** — change the form default from `playerRatingSystem` to `cycle.settings?.rating_system || playerRatingSystem || 'knltb'`

2. **Replace the rating system `<Select>` dropdown** (~lines 560–583) with a read-only display showing the system name (similar to how `CycleForm.tsx` handles `fixedRatingSystem`):
   ```
   <FormItem>
     <FormLabel>Rating System</FormLabel>
     <p className="text-sm text-muted-foreground">{systemName}</p>
   </FormItem>
   ```

3. **Load the system name** — use the already-loaded `ratingSystems` array to look up the display name from the cycle's rating system code.

| File | Change |
|------|--------|
| `src/components/cycles/CycleApplicationForm.tsx` | Lock rating_system to cycle setting, show as read-only label |

Single file, ~15 lines changed.

