

## Fix Cycle Display on Trainer Profile Page

### Problem 1: Only one cycle shows as a summary card
In `TrainerOpenSlots.tsx` line 144, the grouping condition is:
```
if (slot.cyclus_id && !slot.allow_single_booking)
```
This means cycles with `allow_single_booking = true` are broken apart into individual slot rows instead of showing as a cycle summary card. Both cycles should always appear as summary cards.

### Problem 2: Individual slots from bookable cycles don't show
When a cycle has `allow_single_booking = true`, users should see both the cycle summary card AND the individual session rows below it (so they can book single sessions). Currently those slots get dumped into individualSlots but because the condition sends ALL slots of that cycle type to individual, it works -- except the cycle card itself is missing. With the fix, we need to ensure both appear.

### Changes

**File: `src/components/trainer/TrainerOpenSlots.tsx`**

1. Change the grouping logic (lines 143-151) so ALL slots with a `cyclus_id` are grouped into cycle summary cards, regardless of `allow_single_booking`
2. Additionally, if a cycle has `allow_single_booking = true`, also add its slots to the individual slots list so they appear as bookable day-grouped rows below the cycle cards
3. This mirrors how `BookLesson.tsx` already handles it -- showing cycle bundles at the top and individual bookable sessions below

The updated logic:
- All slots with `cyclus_id` go into `cycleSlotMap` (for cycle summary cards)
- Slots without `cyclus_id` go into `individualSlots`
- Slots with `cyclus_id` AND `allow_single_booking = true` ALSO go into `individualSlots` (so single sessions are bookable)

### Result
- Both cycles appear as separate summary cards at the top of "Available Slots"
- Cycles that allow single booking also show their individual sessions below, grouped by date
- The total slot count badge reflects both cycle cards and individual slots

