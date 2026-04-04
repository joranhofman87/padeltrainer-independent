

# Redesign Overview Tab: Week View + Filters

## Problem
The current Overview tab shows a month mini-calendar with dots and a small "upcoming" sidebar. It doesn't show what's actually scheduled, and with 4+ trainers per day, a per-trainer column layout would get cramped fast.

## Solution
Replace the month grid with a **week schedule view** that groups slots by **time**, not by trainer. Each day column shows compact slot cards sorted by time, with the trainer name on each card. This scales well regardless of how many trainers work a given day. Add location and trainer filter dropdowns.

### New layout

```text
┌─────────────────────────────────────────────────────┐
│ [Sessions: 12] [Fill: 78%] [Open: 3] [Booked: 24/32]│
├─────────────────────────────────────────────────────┤
│ Filters: [Location ▼] [Trainer ▼]                   │
├─────────────────────────────────────────────────────┤
│  Mon 7      Tue 8      Wed 9      Thu 10     Fri 11 │
│ ┌────────┐ ┌────────┐ ┌────────┐                    │
│ │09:00   │ │09:00   │ │09:00   │                     │
│ │Coach A │ │Coach B │ │Coach A │                     │
│ │3/4 ███ │ │1/4 █   │ │4/4 ✓  │                     │
│ │Loc: X  │ │        │ │Loc: X │                      │
│ └────────┘ └────────┘ └────────┘                    │
│ ┌────────┐ ┌────────┐                               │
│ │10:00   │ │10:00   │                                │
│ │Coach C │ │Coach A │                                │
│ │2/4 ██  │ │0/4     │                                │
│ └────────┘ └────────┘                               │
│            ┌────────┐                               │
│            │14:00   │                                │
│            │Coach D │                                │
│            │0/4     │                                │
│            └────────┘                               │
└─────────────────────────────────────────────────────┘
```

Key design decision: slots are listed **vertically within each day column** sorted by time, not split across trainer columns. This means 4+ trainers at the same time just stack as separate cards rather than requiring horizontal space per trainer. Much more scalable.

### Slot card design
Each compact card shows:
- Time range (e.g., "09:00–10:00")
- Trainer name (small text)
- Location name if present
- Occupancy bar: colored fill proportional to booked/max (green=full, amber=partial, gray=empty)
- Click → navigates to Manage tab for that day

### Filter dropdowns
- Location and Trainer select dropdowns above the week grid
- Already available as `trainers` and `locations` state in `AcademyCalendar.tsx`
- Filters apply to both the slot cards shown AND the stat cards

## Changes

| File | Change |
|------|--------|
| `src/components/academy/AcademyCalendarOverview.tsx` | Rewrite: remove month grid + upcoming sidebar. Add 7 day-columns with slot cards sorted by time. Accept `trainers`, `locations`, and filter props. Keep stat cards at top. |
| `src/pages/academy/AcademyCalendar.tsx` | Pass trainers, locations, filter state, and filter setters to Overview. Switch Overview to use week-based `slots` instead of `monthSlots`. |

## Details
- Overview now uses the same weekly `slots` array already fetched for the Manage tab — no new data fetching
- Stats cards recalculate based on filtered slots
- Day columns use `overflow-y-auto` with a max-height so days with many slots scroll vertically
- On mobile (< lg), day columns stack vertically or show as a horizontal scroll
- Clicking a slot card calls `onDayClick(day)` which switches to the Manage tab

