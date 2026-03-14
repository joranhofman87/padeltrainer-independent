

# Fix Proposal Generation and Schedule View

## Root Cause Analysis

There are **two distinct problems**:

### Problem 1: Stale 8-hour slots in the database
The `generate-proposals` edge function creates new availability slots every time it runs, but **never deletes old ones** from previous runs. This cycle (`09b9d410`) now has **1,065 slots** -- most are stale duplicates. The breakdown shows:
- 616 slots of 1 hour (correct, from the latest fix)
- 398 slots of 8 hours (old, pre-fix runs)
- ~38 slots of 10.5-13 hours (even older runs)

When the algorithm runs, it picks from **all** slots (including the 8-hour ones) since they match the player's time windows. Five players got assigned to the same 8-hour slot `950928c7` (09:00-17:00).

### Problem 2: Schedule grid shows raw slot times, not session-length blocks
The `ProposalScheduleGrid` renders blocks based on the **slot's** start/end time (09:00-17:00), not the session duration. Even with correctly generated 1-hour slots, the grid is hard to read at scale because it renders one block per registration rather than grouping by slot.

## Plan

### 1. Edge function: Delete old cycle slots before creating new ones
In `generate-proposals/index.ts`, before inserting new slots, delete all existing `availability_slots` where `cyclus_id = cycleId`. This prevents accumulation of stale slots across regenerations.

Also: check the trainer's **existing bookings/slots** (non-cycle ones) to avoid double-booking. When generating slots from trainer availability windows, query the trainer's existing `availability_slots` that are NOT part of this cycle and exclude time ranges that overlap.

### 2. Edge function: Respect `preferred_duration_minutes` per registration
Currently the function uses `cycle.settings.default_duration_minutes` as a single session size for all generated slots. Instead:
- Group intake requests by their `preferred_duration_minutes` (60 vs 90)
- Generate slots of **both** durations from each trainer availability window
- During scoring, only match a request to a slot whose duration matches their `preferred_duration_minutes` (strict match)

### 3. Replace `ProposalScheduleGrid` with aggregated slot cards
Replace the current per-registration block grid with a slot-centric view that scales to 100+ registrations:

```text
┌─────────────────────────────────────────────┐
│ Monday                                      │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────┐ │
│ │ 09:00 - 10:00  ·  Trainer Name          │ │
│ │ 3/4 players  ·  Avg confidence: 82%     │ │
│ │ ┌─────┐ ┌─────┐ ┌─────┐                │ │
│ │ │ Jan │ │ Piet│ │ Eva │                 │ │
│ │ │ 7.5 │ │ 6.0 │ │ 8.0 │                 │ │
│ │ └─────┘ └─────┘ └─────┘                │ │
│ └─────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────┐ │
│ │ 10:00 - 11:30  ·  Trainer Name          │ │
│ │ 1/4 players  ·  90 min session          │ │
│ │ ...                                     │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Each slot card shows:
- Time range + trainer (with avatar)
- Occupancy (current/max) + session duration badge
- Player chips with name + rating + confidence score
- Click a player chip to open the detail sheet
- Click the slot card to see all details
- Visual indicator when slot is full vs has space
- Color coding by confidence (green/amber/red)

Group cards by day (tabs) then by trainer (columns or sections). Empty slots are also shown so managers can see available capacity.

### 4. Add drag-to-reassign capability
On each player chip in the slot card, add a small "move" button that opens the existing `ReassignPlayerDialog`. This reuses the current reassignment infrastructure.

### 5. Data cleanup migration
Delete the 1,065 stale slots for this specific cycle so the user can start fresh. This is a one-time cleanup.

## Files to change

**Edge function** (`supabase/functions/generate-proposals/index.ts`):
- Add slot cleanup: delete `availability_slots` where `cyclus_id = cycleId` before generating new ones
- Check trainer's existing (non-cycle) slots for conflicts
- Generate slots per unique `preferred_duration_minutes` from intake requests
- Only score a request against slots matching their duration (strict filter)

**Schedule grid** (`src/components/cycles/ProposalScheduleGrid.tsx`):
- Complete rewrite to slot-centric aggregated cards
- Group by day (tabs) -> trainer sections -> slot cards -> player chips
- Show occupancy, duration, confidence, ratings
- Player chips clickable for detail sheet
- Move button per player for reassignment
- Show empty slots for capacity overview

**Supporting changes**:
- `src/lib/cycles.ts`: Update `getAvailableSlotsForCycle` to include empty slots (not just those with assignments)
- `src/lib/cycles.ts`: Add `SlotWithOccupancy` data to `ProposalDetails` or create a new fetch function for the aggregated view

**Database cleanup** (one-time migration):
- Delete stale availability_slots where `cyclus_id = '09b9d410-a77f-45ba-9cae-2c76b0928d34'`

