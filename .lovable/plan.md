

# Holiday Dates & Cycle Info on Approve & Book Screen

## Problem
When approving proposals, the trainer/academy has no way to:
1. Mark holiday dates to exclude from the recurring schedule (so those weeks don't generate bookings)
2. See the cycle's start and end dates at a glance
3. See the actual number of sessions per slot (adjusted for excluded holidays)

## Approach

### 1. Add `excluded_dates` to CycleSettings
Store an array of date strings (e.g. `["2026-07-20", "2026-08-03"]`) in `CycleSettings` so they persist with the cycle and can be used by the finalize-proposals edge function.

### 2. Show Cycle Info Card on ProposalOverviewPage
Above the summary cards, add a small info section showing:
- Cycle name
- Start date -- End date
- Number of weeks
- Excluded holiday dates (with add/remove UI)
- Effective sessions count per slot (weeks minus holidays that fall on that slot's weekday)

### 3. Holiday Date Picker
A simple date picker where the user can click dates to mark as holidays. Show them as removable chips/badges. When a date is added/removed, update the cycle's `settings.excluded_dates` in the DB.

### 4. Session Count Display
For each slot in the overview table, show "X sessions" based on: total weeks between start_date and end_date, minus weeks where the slot's weekday falls on an excluded date. This gives the trainer a clear picture of actual sessions.

### 5. Pass excluded_dates to finalize-proposals
The edge function should read `excluded_dates` from cycle settings and skip creating bookings for slots on those dates. (This is a future concern for when recurring bookings are generated -- for now, showing the count is the priority.)

## Files

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `excluded_dates?: string[]` to `CycleSettings` |
| `src/pages/ProposalOverviewPage.tsx` | Fetch cycle data; show start/end dates, holiday picker, and per-slot session counts |
| `src/i18n/locales/en/cycles.json` | Add translations for holiday UI labels |
| `src/i18n/locales/nl/cycles.json` | Add Dutch translations |
| `src/i18n/locales/de/cycles.json` | Add German translations |

## UI Detail

```text
┌─────────────────────────────────────────────┐
│  Proposal Overview                          │
│                                             │
│  ┌─ Cycle Info ──────────────────────────┐  │
│  │ Period: 1 Apr 2026 — 20 Jun 2026      │  │
│  │ Weeks: 12                             │  │
│  │                                       │  │
│  │ Holiday dates:                        │  │
│  │ [+ Add date]                          │  │
│  │ [27 Apr 2026 ×] [1 Jun 2026 ×]       │  │
│  │                                       │  │
│  │ Sessions per group: 10 (12 weeks      │  │
│  │  minus 2 holidays on matching days)   │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  [Summary cards: slots, players, etc.]      │
│  [Trainer accordion...]                     │
└─────────────────────────────────────────────┘
```

The session count is computed client-side by checking which excluded dates fall on the same weekday as each slot, giving per-slot accuracy.

