

# Fix White Screen Flash When Linking/Unlinking Players

## Problem
`onLinkChanged` calls `fetchData()` in the parent page, which sets `setIsLoading(true)` — causing the entire page to render a skeleton loader and the drawer to disappear momentarily.

## Fix

### `src/pages/TrainerIntakeRequests.tsx`
1. Create a separate `refreshData()` function that does the same work as `fetchData()` but does **not** set `setIsLoading(true)`. It silently refreshes requests and player links in the background.
2. Pass `refreshData` (instead of `fetchData`) as the `onLinkChanged` callback to both `IntakeRequestDetailSheet` and `IntakeRequestsTable`.
3. Keep `fetchData` (with loading skeleton) only for the initial load.

### `src/pages/academy/AcademyIntakeRequests.tsx`
Same change — add a silent `refreshData` and pass it as `onLinkChanged`.

### `src/components/cycles/IntakeRequestDetailSheet.tsx`
In `handleUnlinkPlayer`, add optimistic removal: filter `optimisticLinkedIds` to remove the unlinked player immediately, same pattern as linking already uses. This makes unlink feel instant too.

## Files

| File | Change |
|------|--------|
| `src/pages/TrainerIntakeRequests.tsx` | Add silent `refreshData`, use it for `onLinkChanged` |
| `src/pages/academy/AcademyIntakeRequests.tsx` | Same |
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Optimistic unlink removal |

