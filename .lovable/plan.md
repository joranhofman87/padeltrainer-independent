

# Fix Half-Hour Slot Display in Calendar Grid

## Problem
Slots starting at :30 (e.g., 10:30-12:00, 11:30-12:30) use absolute positioning with a top offset of 50% of the cell height. This causes:
- Slots to overlap into adjacent hour cells awkwardly
- Visual clipping and z-index issues
- Poor rendering on mobile where absolute positioning doesn't work well in the list layout

## Approach: Use half-hour grid rows instead of absolute positioning

Replace the current 1-hour grid (16 rows for 08:00-23:00) with a half-hour grid (32 rows). Each row is a 30-minute segment. This eliminates all absolute positioning math — a slot simply spans the correct number of rows using CSS Grid's `grid-row` placement.

## Changes

### `src/components/trainer/TrainerCalendarGrid.tsx`

**Desktop week view:**
1. Change `HOURS` to half-hour increments: `[8, 8.5, 9, 9.5, ..., 23]` (32 entries)
2. Only show time labels on full hours (skip :30 rows' labels)
3. Half-hour rows get `min-h-[40px]` (half of current 80px) — full hours still visually appear as 80px total
4. Map slots to their correct half-hour row; slots span multiple rows via `grid-row: span N` based on duration
5. Remove `occupiedCells` logic and `getSlotStartOffset` — no longer needed
6. Use CSS Grid with `grid-template-rows` for the time body so slots can span rows naturally

**Mobile view:**
- Group slots by their actual start time (not just hour)
- Show slots in a flat sorted list — no grid math needed, so half-hours just work naturally
- Already mostly works, just ensure the time label shows `:30` correctly

### `src/components/trainer/CalendarSlotCard.tsx`

- Remove `startOffset` prop and absolute positioning logic
- Keep `durationHours` for height calculation within grid cells (now expressed as row span)
- Remove `needsPositioning`, `topOffset`, `absolute` class

## Technical details

```text
Current: 1-hour grid + absolute offsets
┌──────────┐
│ 10:00    │  ← 80px cell
│  [10:30 slot starts here via position:absolute, top:40px]
├──────────┤
│ 11:00    │  ← slot overflows into this cell
└──────────┘

New: half-hour grid rows
┌──────────┐
│ 10:00    │  ← 40px row
├──────────┤
│          │  ← 40px row (no label), slot starts here, spans 2-3 rows
├──────────┤
│ 11:00    │  ← slot continues
└──────────┘
```

## Files
- `src/components/trainer/TrainerCalendarGrid.tsx` — Half-hour grid, remove absolute positioning
- `src/components/trainer/CalendarSlotCard.tsx` — Remove startOffset/absolute positioning

