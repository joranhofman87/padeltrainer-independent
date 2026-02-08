

# Enhance Open Slots page: more details + visibility control

## Part 1: Show more details per slot/cycle

### For recurring cycles (cyclus groups)
Currently: only shows cyclus name, lesson title, and session count.

Add to the collapsed cyclus row:
- **Day + time** (e.g. "Wednesdays at 18:00")
- **Date range** (first session date -- last session date, derived from the slots within the group)

These details are already available: we can derive the recurring day/time from the first slot's `start_time`, and the date range from the first and last slot in the group.

### For individual (one-off) slots
Currently: shows day + time and spots count.

Add:
- **End time** (e.g. "Wed 5 Feb 18:00 - 19:00" instead of just "Wed 5 Feb at 18:00")
- **Location name** (if linked) -- requires fetching `location_id` and joining `locations(name)` which is not currently done in the open slots query

---

## Part 2: Visibility toggle per slot

### Database
Add a column to `availability_slots`:
```sql
ALTER TABLE public.availability_slots
  ADD COLUMN is_public boolean NOT NULL DEFAULT true;
```

Default `true` preserves current behavior (all slots visible to players).

### Trainer Open Slots page
- Add a toggle (switch) per slot row, allowing trainers to show/hide individual slots from the public profile
- For cyclus groups: add a toggle at the cyclus header level that bulk-toggles all slots in that cycle
- Add a "Toggle all" button in the page header to bulk show/hide all open slots at once
- Toggling updates the `is_public` column on the relevant `availability_slots` rows

### Public-facing queries
Update the `TrainerOpenSlots` component (public trainer profile) to filter on `is_public = true`, so hidden slots don't appear to players. The booking page query should also respect this flag.

---

## Technical Details

### Files to modify

1. **Database migration** -- add `is_public` boolean column to `availability_slots`

2. **`src/pages/OpenSlots.tsx`** (trainer dashboard)
   - Expand the `availability_slots` query to also fetch `location_id`, `locations(name)`, and `is_public`
   - Add `is_public` to the `SlotData` interface
   - Add `location_name` to the `SlotData` interface
   - For cyclus groups: show day + time + date range in the collapsed header
   - For individual slots: show start--end time range and location
   - Add a Switch toggle per slot and per cyclus group header
   - Add a "Toggle all visible/hidden" button in the page header
   - Wire toggle actions to update `availability_slots.is_public` via supabase

3. **`src/components/trainer/TrainerOpenSlots.tsx`** (public profile)
   - Add `.eq('is_public', true)` filter to the query so hidden slots don't show

4. **`src/pages/BookLesson.tsx`** (booking page)
   - Add `.eq('is_public', true)` filter when fetching available slots for players

5. **Translation files** (`en/trainer.json`, `nl/trainer.json`)
   - Add keys for "Visible to players", "Hide from players", "Toggle all", etc.

### No changes to lessons table or booking flow logic
This is purely about slot display details and visibility control.
