## Goal

Eliminate the class of bug where mutations (generate proposals, reset, reset skipped, reassign, approve/reject) update the database but the schedule grid keeps showing stale data. Replace the "freeze the cache forever" strategy with the standard TanStack Query optimistic-update pattern.

## Background

Today `useScheduleSlotsQuery` in `src/hooks/useProposalData.ts` uses:
- `staleTime: Infinity`
- `refetchOnWindowFocus: false`
- `placeholderData: keepPreviousData`

This was added to keep optimistic edits on the schedule grid from flickering. Side effect: `invalidateQueries` no longer triggers a refetch, so any mutation that only invalidates leaves the UI stale until a hard reload. That's exactly what happened with "Generate proposals" showing 7 generated but the grid empty.

This rule is also memorialized in project memory (`mem://architecture/tanstack-query-optimistic-strategy`), so the memory needs to be updated as part of this work.

## Changes

### 1. `src/hooks/useProposalData.ts`
- Drop `staleTime: Infinity` on `useScheduleSlotsQuery`. Use a short staleTime (e.g. `30_000`) so `invalidateQueries` triggers a refetch normally.
- Keep `placeholderData: keepPreviousData` so the grid doesn't blank during refetch.
- Keep `refetchOnWindowFocus: false` (avoids surprise reloads while the user is dragging cards).
- `invalidateSlots` and the slot-related branch of `invalidateAll` stay as `invalidateQueries` — they will now actually refetch.

### 2. Optimistic updates on the schedule grid
Identify every place that currently mutates a slot/proposal optimistically and relies on the frozen cache. Likely call sites:
- `src/pages/academy/AcademyCycleDetail.tsx` (drag-to-reassign, approve, reject, reset, reset skipped, generate)
- `src/components/cycles/ProposalScheduleGrid.tsx` (or equivalent grid component used there)
- `src/components/cycles/ReassignPlayerDialog.tsx`
- `src/components/cycles/ProposalCard.tsx` (approve/reject)

For each optimistic mutation, switch to the canonical pattern:
```ts
await queryClient.cancelQueries({ queryKey: ['proposal-slots', cycleId] });
const previous = queryClient.getQueryData(['proposal-slots', cycleId]);
queryClient.setQueryData(['proposal-slots', cycleId], next); // deep-cloned mutation
try {
  await serverMutation();
} catch (err) {
  queryClient.setQueryData(['proposal-slots', cycleId], previous); // rollback
  throw err;
} finally {
  queryClient.invalidateQueries({ queryKey: ['proposal-slots', cycleId] });
}
```
This gives the same "no flicker" UX without freezing the cache.

### 3. Remove the now-unnecessary explicit `refetchQueries` in `handleGenerateProposals`
With staleTime lowered, the `invalidateAll(...)` call already covers it. Keeps the code consistent across handlers.

### 4. Update project memory
Edit `mem://architecture/tanstack-query-optimistic-strategy` to reflect the new rule:
- "proposal-slots uses standard staleTime + cancel/setQueryData/rollback for optimistic edits. Do NOT use staleTime: Infinity, because it silently breaks invalidate-driven refetches after mutations."

### 5. Verification
- Generate proposals on a cycle with skipped requests reset → grid populates without reload.
- Reset skipped → grid clears the skipped state and the new tab shows them.
- Reset proposals → grid empties.
- Drag a player from one slot to another → no flicker, rollback works if the server call fails.
- Approve / reject from `ProposalCard` → status badge updates and grid stays consistent.

## Out of scope
- Trainer-side `TrainerCyclus.tsx` parity for the optimistic-pattern refactor only happens if it currently shares the same hook (it does — same `useScheduleSlotsQuery`), so the fix is automatic. No new features.
- No DB / planner / RLS changes.
- No changes to other queries that legitimately want `staleTime: Infinity`.
