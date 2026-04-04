

# Fix: Missing `is_public` in Calendar Query

## Root Cause
During the `is_marked_full` → `is_public` migration, the `is_public` field was **not added** to the `.select()` query in `AcademyCalendar.tsx` (line 255). The query fetches slot data but omits `is_public`, so `slot.is_public` is always `undefined`. This causes:

- **Overview tab**: `getGroupStatus` treats `undefined` as falsy → `!s.is_public` is always `true` → all slots appear "full"/hidden
- **Manage tab (DayGrid)**: `!slot.is_public` is `true` → every slot is marked as "isFull", hiding them or showing them incorrectly

## Fix

### `src/pages/academy/AcademyCalendar.tsx` — Add `is_public` to select query

Line 255, add `is_public` to the select string:

```
id, trainer_id, start_time, end_time, max_participants,
is_public, location_id, cyclus_id, cyclus_name, ...
```

One-line fix. All downstream mapping (line 340) and overview/grid components already reference `is_public` correctly.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCalendar.tsx` | Add `is_public` to the `.select()` query string (line 255) |

