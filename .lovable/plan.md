

# Fix: Enforce Max Group Size + Add Configurable Setting

## Problem
1. **Critical bug**: The individual assignment loop (line 858-994) never filters out full slots. Capacity is only a *scoring factor* — a slot at 10/4 still gets a positive score from time, trainer, level, etc. and players keep getting assigned.
2. **No configurable max group size** in the wizard. It defaults to `cycle.settings?.max_group_size || 4` but trainers can't change it per generation run.

## Fix 1: Hard capacity filter in the edge function

### `supabase/functions/generate-proposals/index.ts`
In the individual scoring loop (~line 858), add a hard filter that excludes slots where current assignments + bookings >= max_participants:

```typescript
const matchingSlots = slots.filter((slot) => {
  if (reservedSlots.has(slot.id)) return false;
  // HARD CAP: skip slots that are already full
  const maxP = slot.max_participants || defaultMaxParticipants;
  const currentBookings = bookingCounts[slot.id] || 0;
  const currentAssignments = slotAssignments[slot.id]?.length || 0;
  if (currentBookings + currentAssignments >= maxP) return false;
  // Time window match
  return request.preferred_time_windows.some((tw) =>
    matchesTimeWindow(slot.start_time, tw)
  );
});
```

Also add `defaultMaxParticipants` at the top of the handler (it's currently only defined inside the linked-groups block).

## Fix 2: Add "Max group size" input to the wizard

### `src/components/cycles/GenerateProposalsWizard.tsx`
- Add `maxGroupSize` state (default from `cycle.settings?.max_group_size || 4`), persisted in localStorage draft
- Show a number input in Step 3 (Additional Criteria) labeled "Max players per group"
- Pass it through `GenerateProposalsConfig`

### `src/lib/cycles.ts`
- Add `maxGroupSize` to the config interface and pass it to the edge function

### `supabase/functions/generate-proposals/index.ts`
- Accept `maxGroupSize` from request body
- Use it as `defaultMaxParticipants` instead of always reading from `cycle.settings`
- Apply it when creating slots (line 602: `max_participants`) and when checking capacity

## Result
- Slots are never over-filled — hard cap enforced
- Trainers can set max group size (default 4 for padel) per generation run
- The setting is persisted in the wizard draft

## Files

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Add hard capacity filter + accept `maxGroupSize` param |
| `src/components/cycles/GenerateProposalsWizard.tsx` | Add max group size input in step 3 |
| `src/lib/cycles.ts` | Add `maxGroupSize` to config interface |

