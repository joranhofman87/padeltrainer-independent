

# Fix Overview Tab: Time-sorted layout, marked-full handling, + New button placement

## Issues
1. **Slots at 18:00 appear on same visual row as 10:00** — slots just stack in order per day column with no time alignment across columns, making it hard to scan
2. **Marked-full slots still show occupancy bar with room** — `is_marked_full` not passed to overview, so full-marked slots look like they have availability
3. **"+ New" button sits in the top header** — should be inline above the calendar grid

## Changes

| File | Change |
|------|--------|
| `src/components/academy/AcademyCalendarOverview.tsx` | 1) Switch from free-stacking to a **time-row grid**: compute all unique time slots across the week, create a row per timeslot, render cards in the correct day column at the correct time row. This aligns 10:00 across all days on one row, 18:00 on another. 2) Accept `is_marked_full` on `SlotSummary` — when true, show full green styling + "Full" badge, hide occupancy bar. 3) Accept `onNewClick` prop, render "+ New" button next to the Today button in the nav row. |
| `src/pages/academy/AcademyCalendar.tsx` | Pass `is_marked_full` in `overviewSlots` mapping. Pass `onNewClick` handler to open `BulkCreateSheet`. Hide top-level "+ New" button when on overview tab (it's now inside the component). |

## Layout (after)

```text
[Stats cards]

◀ 6 apr - 12 apr ▶ Today  [+ New]    [Location▼] [Trainer▼]

         MON    TUE    WED    THU    FRI    SAT    SUN
09:00                                       [card] 
10:00    [card]  [card]              [card]  [card]
10:30                   [card]
11:00                                       [card]
12:30             [card] [card]
14:00    [card]   [card]
...
18:00                          [card]
19:00                          [card]
```

Each unique start-time gets its own row. Within a row, cards only appear in the day columns that have a slot at that time. Empty cells stay blank. This gives a clear visual timeline.

## Detail

**Time-row approach**:
- Collect all unique `start_time` hours across the week's slots (e.g., "09:00", "10:00", "10:30", ...)
- Sort chronologically
- Render as a grid: first column = time label, then 7 day columns
- Each cell either has a slot card or is empty
- Multiple slots at the same time in the same day (different trainers) stack vertically within that cell

**Marked-full logic**:
- When `is_marked_full === true`: show green border + "Full" badge, no occupancy bar
- When `is_marked_full === false && booked >= max`: show green border + "Full" badge + occupancy bar (genuinely full)
- Otherwise: show occupancy bar normally

