

# Add "Mark as Private" Option for Registration-Generated Slots

## Problem
When slots are generated from registration intake requests (via `generate-proposals`), `is_marked_full` is hardcoded to `false`. For private/duo/trio lessons, the admin wants to prevent empty spots from being shown publicly. They need a way to mark sessions as private during the review step.

## Changes

### 1. `supabase/functions/generate-proposals/index.ts` — Auto-set `is_marked_full` based on lesson type

When generating slots from an intake request, check the request's `lesson_type`. If it's `private`, `duo`, or `group3`, default `is_marked_full` to `true` so that these sessions aren't publicly visible by default.

| What | Detail |
|------|--------|
| Line ~628 | Replace `is_marked_full: false` with logic that checks intake request lesson type to determine if the slot should be private |

### 2. `src/components/cycles/ProposalScheduleGrid.tsx` — Add per-slot privacy toggle

In the slot card within the proposal grid, add a small Lock icon toggle so the admin can override the auto-detected privacy setting per slot during the Review & Edit step (Step 4).

| What | Detail |
|------|--------|
| `SlotWithOccupancy` interface | Add `is_marked_full: boolean` field |
| Slot card UI | Add a Lock/LockOpen icon button that toggles privacy, calling a new `onToggleSlotPrivacy` callback |
| Props | Add `onToggleSlotPrivacy?: (slotId: string, value: boolean) => void` |

### 3. `src/pages/academy/AcademyCycleDetail.tsx` — Wire privacy toggle handler

Add a handler that updates the `availability_slots.is_marked_full` field when the admin toggles privacy in the proposal grid.

### 4. `src/lib/cycles.ts` — Ensure `is_marked_full` is included in schedule slot queries

The `getScheduleSlots` or equivalent function should select and return `is_marked_full` so the grid can display current state.

## File summary

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Auto-set `is_marked_full` based on intake request `lesson_type` |
| `src/components/cycles/ProposalScheduleGrid.tsx` | Add `is_marked_full` to slot interface, add toggle UI |
| `src/pages/academy/AcademyCycleDetail.tsx` | Wire `onToggleSlotPrivacy` handler |
| `src/lib/cycles.ts` | Include `is_marked_full` in schedule slot queries |

