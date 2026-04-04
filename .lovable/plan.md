

# Fix: Proposals "disappearing" after Approve & Book

## Root cause

Two bugs working together:

1. **Status mismatch on the Registrations list page**: The `finalize-proposals` edge function sets intake request status to `'booked'`. But `AcademyIntakeRequests.tsx` only filters for `'confirmed'` — it never checks for `'booked'`. So after approval, requests vanish from the "Confirmed" tab. The cycle detail page (`AcademyCycleDetail.tsx`) already handles this correctly with `status === 'confirmed' || status === 'booked'`, but the main list page doesn't.

2. **Auto-heal side-effect**: `getAvailableSlotsForCycle` in `src/lib/cycles.ts` (lines 1072-1093) silently resets any `'proposed'` intake requests to `'new'` when it finds no slots/assignments. This is a destructive mutation hidden inside a read function. If the schedule grid loads during a timing gap (e.g. between finalization steps), it can wipe proposal state.

## Changes

| File | Change |
|------|--------|
| `src/pages/academy/AcademyIntakeRequests.tsx` | In the `filteredRequests` memo and all status counts, treat `'booked'` as equivalent to `'confirmed'` (same pattern as `AcademyCycleDetail.tsx`). Update the confirmed filter: `r.status === 'confirmed' \|\| r.status === 'booked'`. Update `confirmedCount` similarly. |
| `src/lib/cycles.ts` | Remove the auto-heal block (lines 1072-1093). Orphan cleanup should only happen via the explicit `resetProposals` action, not as a hidden side-effect of a data-fetch function. |

## Impact
- After approving proposals, requests correctly appear under the "Confirmed" tab on both the list page and detail page
- No more silent data mutations during read operations
- Existing `resetProposals` flow still handles cleanup when explicitly triggered

