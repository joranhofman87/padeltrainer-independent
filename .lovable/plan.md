

# Fix Cycles Tab to Show All Cycles (Including Registration-Created)

## Problem
The Cycles tab only queries `availability_slots` grouped by `cyclus_id`. Cycles created via the registration form are stored in the `cycles` table and may not have slots generated yet. This means only trainers who had slots manually created with a cyclus show up (like Rene), while cycles from registrations (Tygho, Patrick, Yannick) are invisible.

## Root Cause
`AcademyCyclusOverview.tsx` line 116-126 queries `availability_slots` only. It never queries the `cycles` table.

## Solution
Use the `cycles` table as the primary data source, then enrich each cycle with slot/booking data from `availability_slots`.

## Changes

### `src/pages/academy/AcademyCyclusOverview.tsx`

1. **Query `cycles` table first** — Fetch all cycles where `owner_type = 'academy'` AND `owner_id = activeAcademy.id`, plus cycles where `owner_type = 'trainer'` AND `owner_id` is one of the academy's trainer IDs (since trainers can own cycles too).

2. **Then enrich with slot data** — For each cycle, query `availability_slots` where `cyclus_id = cycle.id` to get session count, player bookings, day/time, period, etc.

3. **Update `CyclusGroup` interface** — Add fields: `status` (draft/open/closed), `type` (registration/cyclus/event), `has_slots` (boolean). Keep existing fields for slot-derived data.

4. **Handle cycles without slots** — Show them with sessions = 0, period from `cycles.start_date`/`end_date`, and a badge indicating "No sessions scheduled".

5. **Merge logic** — Any `availability_slots` with a `cyclus_id` that matches a `cycles.id` gets merged. Orphan slot groups (cyclus_id not in cycles table) still appear as before.

6. **Row click** — For cycles with slots, navigate to first slot detail. For cycles without slots, navigate to the cycle management page at `/app/academy/cycles/{cycle.id}`.

### Query approach (pseudocode)
```text
1. Fetch cycles from `cycles` table (academy-owned + trainer-owned)
2. Fetch all availability_slots with cyclus_id IN cycle IDs
3. Group slots by cyclus_id
4. For each cycle: merge slot data (sessions, players, day/time)
5. Also check for orphan slot groups (cyclus_id not in cycles table) — include those too
```

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCyclusOverview.tsx` | Rewrite data fetching to use `cycles` table as primary source, enrich with slot data |

