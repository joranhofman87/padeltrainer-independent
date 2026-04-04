

# Redesign Academy Calendar into a Multi-Tab Hub

## Problem
The current Academy Calendar dumps you straight into a day/week grid. There's no high-level overview, no quick way to see open spots, no trainer hours tracking, and the navigation between "managing" and "viewing" is unclear.

## Proposal: 4-Tab Layout

Replace the current single-page calendar with a tabbed hub at `/app/academy/calendar`. The sidebar navigation collapses — remove the separate "Open Slots" sub-item and fold everything into this one page.

```text
┌──────────────────────────────────────────────────────┐
│  Academy Schedule                                     │
│  ┌──────────┬──────────┬──────────┬─────────────────┐ │
│  │ Overview │ Open     │ Manage   │ Trainer Hours   │ │
│  │          │ Spots    │ Agenda   │                 │ │
│  └──────────┴──────────┴──────────┴─────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Tab 1: Overview (default landing)
A dashboard-style view of what's happening. Month calendar on top (compact, colored dots per day showing how busy it is), week summary below with key stats:
- Total sessions this week / month
- Players booked vs capacity (fill rate %)
- Upcoming sessions today/tomorrow (list)
- Quick alerts: "3 slots with open spots this week", "2 fully booked days"

Click any day → jumps to Tab 3 (Manage Agenda) for that day.

### Tab 2: Open Spots
Replaces the current `AcademyOpenSlots` page. Same data but embedded as a tab. Shows slots with available capacity, grouped by cycle or individually, with actions to toggle visibility/mark full. No separate page needed anymore.

### Tab 3: Manage Agenda
The drag-and-drop day grid we just built (`AcademyDayGrid`), plus the week overview (`AcademyWeekOverview`). This is the hands-on management view. Exactly what we have now, just nested under a tab.

### Tab 4: Trainer Hours
New. Shows hours worked per trainer for a selected week or month:
- Table: Trainer name | Sessions | Total hours | Hourly rate | Amount
- Toggle between week/month view
- Computed from `availability_slots` that have at least one confirmed booking
- Export option (copy or download CSV) for payroll

## Files

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCalendar.tsx` | Restructure into 4-tab layout. Tab 1 = new overview section. Tab 3 = existing day/week grid (moved into tab). Tab state via URL param `?tab=overview` |
| `src/components/academy/AcademyCalendarOverview.tsx` | **NEW** — Month mini-calendar with occupancy dots + week stats cards + today's upcoming list + alerts for open spots |
| `src/components/academy/AcademyTrainerHours.tsx` | **NEW** — Table showing hours per trainer for selected period, computed from slots with bookings |
| `src/pages/academy/AcademyOpenSlots.tsx` | Embed into Tab 2 by extracting its core into a component, or render inline. The separate route stays as a redirect to `?tab=open-spots` |
| `src/components/academy/AcademySidebar.tsx` | Remove "Open Slots" sub-item. "Calendar" link now goes to the hub. Simplifies the schedule menu group |

## Key details
- Tab state stored in URL search param (`?tab=overview|open-spots|manage|hours`) so links/bookmarks work
- Overview tab fetches a full month of slots in one query to compute stats
- Trainer Hours computed client-side from the same slots data: `duration = (end_time - start_time)` for slots with ≥1 confirmed booking
- Hourly rate comes from `trainer_profiles.hourly_rate` (already fetched in `loadAcademyData`)
- No backend changes needed — all data already available

