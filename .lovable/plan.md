

# Warning Icons on Calendar Overview Slots

## What it does
Show an `AlertTriangle` warning icon on individual slot time rows in the Overview tab when players booked on the same slot have a big level difference or big age difference. The thresholds are configurable in Academy Settings.

## Data availability

| Signal | Status |
|--------|--------|
| Rating spread | Already fetched — `skill_rating` on each booked player via bookings query |
| Age spread | `birth_date` on `profiles` table, but **not** on `guest_players`. Need to: (1) add `birth_date` column to `guest_players`, and (2) fetch it alongside bookings |
| Threshold settings | Don't exist yet — need new columns on `academy_profiles` |

## Changes

### 1. Database migration
- Add `birth_date date` column to `guest_players`
- Add `warning_max_rating_spread numeric` and `warning_max_age_diff_years integer` columns to `academy_profiles` (both nullable, null = no warning)

### 2. `src/pages/academy/AcademySettings.tsx`
Add a "Warnings" card with two numeric inputs:
- **Max rating spread** — e.g. 2.0 points (players in same slot with ratings further apart trigger warning)
- **Max age difference** — e.g. 5 years
Both default to null (disabled). Saved to `academy_profiles`.

### 3. `src/pages/academy/AcademyCalendar.tsx`
- Expand the `overviewSlots` mapping to include player data (ratings + birth dates) per slot
- Extend the `SlotSummary` interface to carry `players: { rating: number | null; birthDate: string | null }[]`
- Fetch `birth_date` from `profiles` and `guest_players` in the bookings query
- Fetch academy warning thresholds alongside the slot data
- Pass thresholds to `AcademyCalendarOverview`

### 4. `src/components/academy/AcademyCalendarOverview.tsx`
- Accept new props: `warningMaxRatingSpread` and `warningMaxAgeDiffYears` (both `number | null`)
- Extend `SlotSummary` with `players` array
- In each slot row, compute:
  - Rating spread = max rating - min rating among players with ratings
  - Age spread = max age - min age among players with birth dates
- If either exceeds threshold, show an `AlertTriangle` icon (amber) next to the time range
- Tooltip on the icon explains what triggered it (e.g. "Rating spread: 3.2 points")
- Add warning icon to the legend row

### 5. Backfill `guest_players.birth_date`
- Create a one-time migration that copies `birth_date` from `intake_requests` to `guest_players` where a match exists (by email or linked profile)

## File summary

| File | Change |
|------|--------|
| Migration SQL | Add `birth_date` to `guest_players`, add warning threshold columns to `academy_profiles`, backfill birth dates |
| `src/pages/academy/AcademySettings.tsx` | Add "Warnings" settings card with two threshold inputs |
| `src/pages/academy/AcademyCalendar.tsx` | Fetch birth dates + warning thresholds, pass to overview |
| `src/components/academy/AcademyCalendarOverview.tsx` | Compute rating/age spread per slot, show warning icon with tooltip |

