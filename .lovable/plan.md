

# Fix: Proposal Slot Generation & Schedule Grid

## Problems Identified

1. **182 slots created** — The slot generation creates slots for *every week* from start to end date. With a window like Monday 09:00–17:00 and durations of 60 + 90 minutes, that's 13 slots × ~14 weeks = 182 slots. These all get grouped under a single "Mon" tab since `ProposalScheduleGrid` groups by weekday name, making it unmanageable.

2. **Day tabs = trainer switching** — If trainer A only has Monday windows and trainer B only has Wednesday windows, the day tabs effectively act as trainer switches. The grid doesn't separate "which week" so it collapses all Mondays across 14 weeks into one view.

## Proposed Fixes

### A. Edge function: Generate only 1 week of slots (`generate-proposals/index.ts`)

The schedule view shows a weekly pattern — there's no need to generate slots for every week of the cycle. Change the slot generation loop (lines 564-604) to only generate slots for the **first week** after `startDate` that matches each day. Remove the `while (current <= cycleEndDate)` weekly loop — just find the first occurrence of each weekday and create slots for that single week only.

This turns 182 slots into ~13 (one week), which is the actual schedule pattern the user wants to review and assign players to.

### B. ProposalScheduleGrid: Show trainer name in day tabs when relevant

Update the day tabs (lines 118-133) to also show which trainer(s) have slots on that day, so switching days doesn't feel like "switching trainers" without context. Add trainer initials or count next to the day badge when multiple trainers are involved.

### C. Slot count shows per-day count (already correct)

The trainer header already shows `trainerSlots.length` which is filtered per day. With fix A (fewer slots), the count will be reasonable (e.g., 8-13 instead of 182).

## Files to Change

1. **`supabase/functions/generate-proposals/index.ts`** — Remove the weekly loop; generate 1 week of template slots only
2. **`src/components/cycles/ProposalScheduleGrid.tsx`** — Minor: show trainer context in day tabs

