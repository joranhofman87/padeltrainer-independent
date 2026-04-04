

# Add Reports/Analytics Tab to Academy Calendar

## Summary
Remove the 4 stat cards from the Overview tab and create a new "Reports" tab in the calendar hub. This tab becomes the single place for all academy analytics — with period selection, breakdowns by trainer and location, and CSV export.

## Changes

### 1. `src/components/academy/AcademyCalendarOverview.tsx` — Remove stat cards
- Delete the stats calculation (lines 232-239) and the entire `grid grid-cols-2 lg:grid-cols-4` card block (lines 245-290)
- The overview becomes purely the weekly schedule grid

### 2. `src/components/academy/AcademyReportsTab.tsx` — New component
A full reports view with:

**Period & timescale controls:**
- Timescale toggle: Weekly / Monthly
- Period navigation (arrows + label), like the reference screenshot
- "Export CSV" button

**Summary stat cards (top row):**
- Total sessions, fill rate %, slots with open spots, players booked — same stats that were on Overview, but now calculated for the selected period

**Overview table (default view):**
- One row per period (week or month)
- Columns: Period, Sessions, Booked players, Capacity, Fill rate %, Open spots, Private slots, Revenue (if payment data exists)
- Sortable columns

**"By Trainer" sub-tab:**
- Same table but grouped/filtered by trainer
- Trainer selector or one row per trainer per period
- Shows: Trainer name, Sessions, Players, Fill rate, Hours

**"By Location" sub-tab:**
- Same breakdown but per location

**Data fetching:**
- Query `availability_slots` + `bookings` for the selected date range
- Join trainer and location names
- All calculations client-side from the slot data already available in the calendar page

**CSV Export:**
- Export the currently visible table as CSV to `/mnt/documents/` or trigger browser download via `Blob`

### 3. `src/pages/academy/AcademyCalendar.tsx` — Add tab
- Add "Reports" tab with `BarChart3` icon after "Trainer Hours"
- Add `TabsContent` rendering `<AcademyReportsTab />` with academy context (trainers, locations, academy ID)
- Pass the existing `overviewSlots` fetch function or let the Reports tab do its own date-range query

## Layout (reference: uploaded screenshot)

```text
┌──────────────────────────────────────────────────┐
│ Overview | By Trainer | By Location              │
├──────────────────────────────────────────────────┤
│ Period [▾]   Timescale [Monthly ▾]   [Export CSV] │
├──────────────────────────────────────────────────┤
│ Period   Sessions  Booked  Capacity  Fill%  Open │
│ Apr 2026    32       98      128      77%    12  │
│ Mar 2026    28       85      112      76%     8  │
│ ...                                              │
└──────────────────────────────────────────────────┘
```

## File summary

| File | Change |
|------|--------|
| `src/components/academy/AcademyReportsTab.tsx` | **New** — Full reports view with sub-tabs, period controls, tables, export |
| `src/components/academy/AcademyCalendarOverview.tsx` | Remove stat cards block |
| `src/pages/academy/AcademyCalendar.tsx` | Add "Reports" tab trigger + content |

