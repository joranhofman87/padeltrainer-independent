

# Move Slot to a Different Day

## Problem
The schedule grid is organized by day tabs. Drag-and-drop and the edit popover only work within the currently selected day. There's no way to move a group (slot with all its players) from Monday to Tuesday without deleting and recreating it.

## Approach
Add a **day picker** to the existing `SlotEditPopover` (the popover that appears when clicking the edit/settings icon on a slot card). The backend `moveSlot` already supports changing the date — it just updates `start_time` and `end_time` to any new ISO timestamp. We only need to expose the day selection in the UI.

## Changes

### `src/components/cycles/ProposalScheduleGrid.tsx`

**SlotEditPopover** (line 244):
1. Add `availableDays` as a new prop (the list of days like `['Monday', 'Tuesday', ...]`)
2. Add a day selector (small `Select` dropdown) above the start/end time pickers, initialized to the current `selectedDay`
3. When a different day is chosen, recalculate the reference date: find the correct calendar date for that day of the week relative to the slot's current date (e.g., if slot is on Monday the 7th and user picks Tuesday, compute the 8th)
4. In `handleApply`, use the selected day's date instead of always using `refDate` from the current slot — this shifts `start_time`/`end_time` to the new day while preserving the chosen times
5. Update overlap detection to check against slots on the **target day**, not just `daySlots` (current day). Pass all `slots` to the popover so it can filter by target day.

**Wiring** (~line 630):
- Pass `availableDays` and full `slots` array down to `SlotEditPopover`

No backend changes needed — `moveSlot` already handles arbitrary date/time updates.

## Result
- Trainer opens the edit popover on a Monday slot → sees a day dropdown defaulting to "Monday"
- Changes it to "Tuesday", picks the desired time → clicks Apply
- The entire group (slot + all assigned players) moves to Tuesday
- The grid refreshes and shows the slot on the Tuesday tab

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Add day selector to `SlotEditPopover`; pass `availableDays` and all `slots` as props |

