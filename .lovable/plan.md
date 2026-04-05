

# Add Players Column to All Slots Table

## Problem
The "All Slots" table currently shows Date/Time, Cyclus, Trainer, Location, Spots, Price, and Public toggle. It's missing a "Players" column showing who is booked into each slot.

## Changes

### `src/pages/academy/AcademyOpenSlots.tsx`

1. **Extend `FlatSlot` interface** — add `player_names: string[]`

2. **Update `fetchSlots`** — after fetching booking counts, also fetch booking details with player names:
   - Query `bookings` joined with `profiles` (via `user_id`) to get `full_name` for each confirmed/pending booking
   - Build a `Record<string, string[]>` mapping slot IDs to arrays of player names
   - Populate `player_names` in the processed slots

3. **Add "Players" column** — between Spots and Price:
   - Sortable by `booked_count`
   - Each cell shows player names as small comma-separated text, or "—" if empty
   - Truncate if more than 2-3 names with a "+N more" indicator

4. **Update `colSpan`** — from 8 to 9 for the empty state row

## No database changes needed
Bookings table already has `user_id` which links to `profiles.user_id` for names.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyOpenSlots.tsx` | Add `player_names` to data model, fetch player names from bookings, add Players column to table |

