

# Add "Cycles" Tab to Calendar — Grouped Slot Overview

## Problem
The "All Slots" tab shows every individual slot, repeating the same cycle name for each week. The user wants a view that **groups slots by cyclus** and shows one row per cycle with aggregated info — players, period, sessions count, pricing, etc.

## Approach
Add a new "Cycles" tab to the calendar page (between "All Slots" and "Manage") that queries all future slots, groups them by `cyclus_id`, and displays a summary table.

## Changes

### 1. New component: `src/pages/academy/AcademyCyclusOverview.tsx`

A table component that:
- Fetches all `availability_slots` for the academy's trainers (same query pattern as AcademyOpenSlots)
- Groups slots by `cyclus_id` (slots without a cyclus_id shown individually or in an "Ungrouped" section)
- For each cycle row, computes and displays:
  - **Cyclus name** (from `cyclus_name`)
  - **Trainer** name
  - **Location** name
  - **Day/Time** (e.g. "Monday 14:00 - 15:00") — derived from the first slot
  - **Period** (first slot date → last slot date)
  - **Sessions** count (number of slots in the group)
  - **Players** — unique player names across all slots in the cycle
  - **Price** per session
  - **Spots** (e.g. "2/4" — max booked across slots / max_participants)
- Filters: Trainer, Location, search
- Sortable columns: Name, Trainer, Period, Sessions, Players count
- Click row → navigate to first slot or show expandable detail with all sessions
- Filters for past/current/future cycles (based on slot dates)

### 2. `src/pages/academy/AcademyCalendar.tsx`

- Add a new `TabsTrigger` with value `"cycles"` between "All Slots" and "Manage"
- Add corresponding `TabsContent` that lazy-loads `AcademyCyclusOverview`
- Icon: `Repeat` or `Layers` from lucide

### Data grouping logic (pseudocode)
```text
slots grouped by cyclus_id:
  - "Cyclus Friday 09:00" → [slot1, slot2, slot3, slot4]
  - "Maandag 14:00 - Floris" → [slot1, slot2, ...]
  - null (ungrouped) → individual rows
```

### Row click behavior
Navigate to the cycle detail/edit — since these are slot-based cycles (not registration cycles from the `cycles` table), clicking could expand the row to show individual sessions, or navigate to the first slot's detail page with a "View all sessions" option.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCyclusOverview.tsx` | New component — grouped cycle table with aggregated data |
| `src/pages/academy/AcademyCalendar.tsx` | Add "Cycles" tab trigger and content |

