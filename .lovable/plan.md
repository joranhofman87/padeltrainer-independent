
## Bundle Cycle Slots in Open Slots Card

### What
Currently, the Open Slots card on the Player Dashboard shows every individual slot separately -- so a 10-week cycle shows as 10 rows. Instead, slots sharing the same `cyclus_id` should be grouped into a single summary row (e.g., "Beginners Course - 8 sessions starting Mon, Mar 3"). Standalone slots (no `cyclus_id`) remain as individual rows.

### How it works

1. **Fetch additional fields**: Add `cyclus_id` and `allow_single_booking` to the query on `availability_slots`.

2. **Group by `cyclus_id`**: After fetching, group slots that share the same `cyclus_id`. Standalone slots (null `cyclus_id`) stay individual.

3. **Build display items**: For each cycle group, create a single summary row showing:
   - Cycle name
   - Number of sessions (e.g., "8 sessions")
   - First session date ("Starting Mon, Mar 3")
   - Trainer name and location
   
   For standalone slots, keep the current per-slot display.

4. **Update the interface**: Replace `FollowedTrainerSlot` with a union-style interface that supports both types:
   - `type: 'slot'` -- individual slot (current behavior)
   - `type: 'cycle'` -- bundled cycle with `sessionCount` and `startTime` of first session

5. **Navigation**: Clicking a cycle row navigates to the trainer profile (same as now), where the full cycle details are visible.

### Changes

**File: `src/pages/PlayerDashboard.tsx`**

- Update `FollowedTrainerSlot` interface: add `type` ('slot' | 'cycle'), `sessionCount`, and `cyclusId` fields.
- Update the `select` query to include `cyclus_id, allow_single_booking`.
- After enrichment, group slots by `cyclus_id`:
  - If `cyclus_id` is null or `allow_single_booking` is true: keep as individual `type: 'slot'` entries.
  - Otherwise: collapse into one `type: 'cycle'` entry per `cyclus_id`, using the earliest `start_time` and total count.
- Increase the raw query limit (to ~50) since grouping reduces the final count, then cap displayed items at 10.
- Update the table rendering: cycle rows show "Cycle name - N sessions" with "Starting [date]" instead of a single date/time.
