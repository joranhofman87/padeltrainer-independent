

# Fill Trainer Agenda with Empty Slots + Smart Drag-and-Drop Swap

## Problem

Currently, the proposal generator only creates slots for durations that match player requests. If Yari works 09:00–17:00 on Friday but only 3 players need a 60min slot, only 3 slots are created. The remaining hours show as empty grid cells with no slots — players can't see what's free, and drag-and-drop is limited.

## Solution

Two changes:

### 1. Generate empty filler slots (edge function)

In `supabase/functions/generate-proposals/index.ts`, after the current slot creation logic (which creates slots per `requestedDurations`), add a **second pass** that fills remaining gaps in each trainer's availability window with empty slots using a default duration (60 min).

Current flow:
- For each trainer window, create slots only for `requestedDurations` (e.g., 60 and 90 min separately, causing overlapping slot sets)

New flow:
- Use a single default duration (60 min) to fill the **entire** trainer availability window with non-overlapping slots
- The matching engine then assigns players to whichever slot fits their time preference
- After matching, unassigned slots remain visible as "empty" in the grid

Concretely, change Step 1 (lines ~564–603):
- Always generate consecutive 60-min slots covering the full window (e.g., 09:00–10:00, 10:00–11:00, ... 16:00–17:00 = 8 slots)
- If some players request 90-min sessions, also create 90-min slots but only where needed (on matching, handled separately)
- Actually, simpler approach: always create 60-min slots for the full window. The matching engine already filters by duration, so 90-min requests won't match 60-min slots and will be skipped (with reason). This keeps the grid clean and uniform.

**Revised approach**: Keep the current duration-based slot generation for matched durations, but after all matching is done, go back and fill any **uncovered time gaps** in each trainer's window with 60-min empty slots. This ensures matched players get their preferred duration while gaps are filled.

### 2. Drag-and-drop: allow replacing empty slots (frontend)

In `ProposalScheduleGrid.tsx`, modify the overlap detection in `handleDragEnd`:
- When a slot is dragged onto a cell occupied by an **empty** slot (no assigned players), allow the move by **swapping** the two slots' times/trainers
- When moving a slot away, create a new empty slot in the vacated position

This requires:
- Checking if the overlapping slot has any `proposed_assignments` (player count = 0)
- If empty: call `onMoveSlot` for the dragged slot AND call a new `onSwapSlot` or two sequential `onMoveSlot` calls to swap positions
- Add a new prop/callback `onSwapSlots?: (slotAId, slotBId, slotANewStart, slotANewEnd, slotBNewStart, slotBNewEnd) => void`

### Files to change

1. **`supabase/functions/generate-proposals/index.ts`**
   - After the scoring/matching loop (line ~858), add a gap-filling step:
     - For each trainer's availability window, find time ranges not covered by any existing cycle slot
     - Insert 60-min filler slots for each gap
   - This ensures the full agenda is visible

2. **`src/lib/cycles.ts`**
   - Add a `swapSlots(slotAId, slotBId, ...)` function that updates both slots' times/trainers in one go

3. **`src/components/cycles/ProposalScheduleGrid.tsx`**
   - Modify `handleDragEnd` overlap logic: if the overlapping slot is empty (no players), allow the swap
   - Determine "empty" by checking `slot.players?.length === 0` or similar from the slot data
   - Call the swap callback instead of blocking

4. **`src/pages/academy/AcademyIntakeRequests.tsx`** and **`src/pages/TrainerIntakeRequests.tsx`**
   - Wire up the new `onSwapSlots` prop

