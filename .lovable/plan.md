

# Fix & Simplify Proposal Generation + Full Agenda

## Root Causes Identified

After auditing the full flow, there are **three bugs** preventing the full-day agenda from appearing:

### Bug 1: Overlapping slot generation for multiple durations
Step 1 (line 567) iterates over `requestedDurations` — if players request both 60 and 90 min, it creates **two full sets of overlapping slots** for the entire window. This corrupts the grid and confuses the gap-filler.

### Bug 2: Gap-filler is a no-op when Step 1 already covers everything
When all requests are 60min, Step 1 already creates 60-min slots covering the full window. Step 3 finds zero gaps. When requests are 90min, the 90-min slots from Step 1 don't align with the 60-min gap-filler grid, causing partial coverage.

### Bug 3: Re-running deletes everything but may create nothing
Line 471-483 deletes **all** cycle slots first. Then line 457 queries only `status = 'new'` requests. If the user re-runs without resetting (requests are `proposed`), all slots are deleted and zero new ones are created.

---

## Simplified Architecture

Replace the current three-step approach with a cleaner two-step flow:

### Step 1: Create uniform 60-min slots for the FULL trainer availability window
- Remove the per-`requestedDuration` loop entirely
- Always generate consecutive 60-min slots from window start to end
- One set of non-overlapping slots per trainer per day

### Step 2: Match players to slots
- Keep the existing scoring engine (time_match, preferred_trainer, level_compatible, etc.)
- Remove the strict duration filter — all slots are 60min now; players requesting different durations get a note but still get matched
- Unmatched slots remain empty and visible in the grid

### Remove Step 3 (gap-filler)
No longer needed since Step 1 creates full coverage.

### Fix re-run safety
Before deleting old slots, also reset any `proposed` requests back to `new` so they're picked up by the matching engine. This way re-running "Generate" works without needing to click "Reset" first.

---

## Files to Change

### 1. `supabase/functions/generate-proposals/index.ts`
- **Step 0**: Add automatic reset of `proposed` → `new` for the cycle's intake requests before slot deletion
- **Step 1** (lines 564-603): Replace the `for (const duration of requestedDurations)` loop with a single 60-min slot generation loop
- **Step 2** (lines 718-721): Remove the strict duration filter (or make it a soft preference that adds/subtracts score)
- **Remove Step 3** (lines 861-953): Delete the gap-filler code entirely — it's now redundant

### 2. `src/components/cycles/IntakeRequestDetailSheet.tsx`
- Add ability to **edit the proposed slot assignment** (change day/time/trainer) from the detail drawer
- Add a dropdown or picker for reassigning to a different slot

### 3. No changes needed to:
- `ProposalScheduleGrid.tsx` — drag-and-drop logic is solid
- `src/lib/cycles.ts` — swap/move functions are correct
- Parent pages — already wired up correctly

---

## Summary of Outcome
- Trainers see a **complete agenda** with all 60-min blocks filled (09:00, 10:00, 11:00, ... 16:00 for a 9-17 day)
- Matched players appear inside their best-scoring slot
- Empty slots are visible and available for drag-and-drop
- Re-running generate works without needing a manual reset first
- Detail sheet allows manual reassignment for edge cases

