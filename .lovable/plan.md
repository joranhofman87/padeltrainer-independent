

# Fix: Deleted Slot Should Return Players to Unplaced

## Problem
When you delete a slot, `deleteSlot()` removes the `proposed_assignments` but does **not** revert the linked `intake_requests` back to status `new`. The players end up with status `proposed` but no assignment — they disappear from both the grid and the unplaced sidebar.

## Fix

### `src/lib/cycles.ts` — `deleteSlot()` function (line 1566)

Before deleting the proposed assignments, fetch them to get all `intake_request_id`s. After deleting assignments, for each intake request check if it has any remaining assignments elsewhere. If not, set its status back to `new` so it appears in the unplaced bucket.

Updated logic:
1. Fetch all `proposed_assignments` for the slot (get their `intake_request_id`s)
2. Delete the `proposed_assignments`
3. For each affected intake request, check if other assignments remain
4. If none remain, update `intake_requests.status` to `new`
5. Delete the slot

This mirrors the existing logic in `unassignPlayer()` which already does this correctly for individual removals.

## Files

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Update `deleteSlot()` to revert orphaned intake requests to `new` status |

