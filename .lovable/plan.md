

## Show "Created at" date on Cyclus groups

The cyclus cards on the Open Slots page don't currently display when they were created. The `availability_slots` table has a `created_at` column that isn't being fetched.

### Changes

**`src/pages/academy/AcademyOpenSlots.tsx`**:
1. Add `created_at` to the query select fields (line ~82)
2. Add `created_at` to the `SlotData` interface
3. When building cyclus groups, track the earliest `created_at` from the group's slots (add a `created_at` field to `CyclusGroup`)
4. Display the created date in the cyclus card summary row (near the date range), using the localized `dateLocale` for formatting — e.g. "Created: 12 Mar 2025"

