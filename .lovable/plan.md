

# Fix Slow/Flickering Link Action in Player Detail Sheet

## Problem
When clicking "Link" on a suggestion in the detail sheet, `onLinkChanged` triggers `fetchData()` in the parent page, which reloads all cycles, all requests, and all player links. This causes:
1. A long loading period while all data refetches
2. The `selectedRequest` object gets replaced with a new reference, causing the sheet to appear to close and reopen
3. It feels "stuck" because the full data reload is slow with 78+ registrations

## Fix

### `src/components/cycles/IntakeRequestDetailSheet.tsx`
- After linking, **don't call `onLinkChanged`** immediately. Instead, optimistically update the local state:
  - Add the newly linked player to `linkedRequestIds` / `linkedRequests` locally
  - Remove the linked player from `suggestedLinks`
  - Show the success toast instantly
- Call `onLinkChanged` in the background (non-blocking) so the parent table eventually refreshes, but the sheet stays open and responsive

Concretely:
1. Add local state `optimisticLinkedIds` that starts from `linkedRequestIds` but can be extended
2. After `linkPlayers()` succeeds, update `optimisticLinkedIds` and show toast — don't await `onLinkChanged`
3. Fire `onLinkChanged?.()` without awaiting it (fire-and-forget) so the table updates in the background
4. Same approach for "Link all" button

### `src/pages/TrainerIntakeRequests.tsx` + `src/pages/academy/AcademyIntakeRequests.tsx`
- In `fetchData`, after reloading requests, **preserve `selectedRequest`** by re-finding the same ID:
  - After `setRequests(requestsData)`, if `selectedRequest` is set, update it to the matching object from `requestsData` so the sheet doesn't flicker

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Optimistic local state update after linking; fire-and-forget `onLinkChanged` |
| `src/pages/TrainerIntakeRequests.tsx` | Preserve `selectedRequest` identity across `fetchData` |
| `src/pages/academy/AcademyIntakeRequests.tsx` | Same preservation |

