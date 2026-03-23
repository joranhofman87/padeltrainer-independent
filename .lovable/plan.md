

# Schedule Overview Page

## What
A new page at `/app/trainer/schedule-overview` under the Schedule (Rooster) sidebar group. It gives trainers a dense, scannable list of all their slots — grouped by cycle and individual bookings — with tabs for Past / Current / Future, payment status indicators, and quick edit actions.

## Layout

```text
┌─────────────────────────────────────────────────┐
│  Schedule Overview                              │
│  [Past] [Current] [Future]     🔍 Search        │
├─────────────────────────────────────────────────┤
│                                                 │
│  ▼ Cyclus: "Monday Beginners" (12 sessions)     │
│  ┌──────────────────────────────────────────┐   │
│  │ Mon Mar 24  09:00-10:00  3/4 players     │   │
│  │ 💰 2 paid · 1 unpaid    [Edit] [▼]      │   │
│  ├──────────────────────────────────────────┤   │
│  │ Mon Mar 31  09:00-10:00  4/4 players     │   │
│  │ 💰 4 paid               [Edit] [▼]      │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ▼ Individual Sessions (no cycle)               │
│  ┌──────────────────────────────────────────┐   │
│  │ Wed Mar 26  14:00-15:00  1/1 player      │   │
│  │ 💰 paid                  [Edit] [▼]      │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Data Approach
- Query `availability_slots` for the trainer with joined `bookings` (status, payment_status, player info via profiles/guest_players)
- Group slots by `cyclus_id` (null = individual)
- Tab filtering: **Past** (all sessions ended), **Current** (cycle has both past + future sessions), **Future** (all sessions upcoming)
- Each slot row shows: date/time, player count, payment summary (paid/unpaid count), location
- Expandable row shows individual player names + their payment status
- Edit button navigates to calendar or opens slot edit

## Changes

### 1. New file: `src/pages/TrainerScheduleOverview.tsx`
- Fetches all trainer slots with bookings in one query
- Groups by cyclus_id, sorts by start_time
- Tabs: Past / Current / Future
- Search filter by cyclus name or player name
- Each cycle section is collapsible, showing slot rows underneath
- Each slot row shows: date, time, player count vs max, payment summary badges
- Expand a slot to see individual players with payment status
- Edit button per slot (navigates to calendar with slot date)

### 2. `src/components/DomainRouter.tsx`
- Add route: `<Route path="schedule-overview" element={<TrainerScheduleOverview />} />`

### 3. `src/components/trainer/TrainerSidebar.tsx`
- Add "Overview" link under the Schedule collapsible group (between Calendar and Open Slots)
- Update `scheduleOpen` check to include `/trainer/schedule-overview`

## Files
- `src/pages/TrainerScheduleOverview.tsx` — New page (~300 lines)
- `src/components/DomainRouter.tsx` — Add route + import
- `src/components/trainer/TrainerSidebar.tsx` — Add sidebar link + update group open check

