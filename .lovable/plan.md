

# Simplify Calendar Grid: Absolute Positioning + Compact Cards

## Problem
The half-hour row grid (40px per row) causes:
- Text overflowing out of slot boxes (visible in screenshot)
- Large empty gaps between slots
- Complex row-spanning logic that's fragile

## Solution
Replace the row-based CSS grid with **absolute positioning** inside each day column — like Google Calendar. Each slot is placed at a pixel offset based on its start time and sized based on duration. No more row spanning, no occupied-cell tracking.

### Desktop Week View (`TrainerCalendarGrid.tsx`)

**Replace the half-hour grid approach with:**
- Keep the 8-column header (time label + 7 days)
- Each day column becomes a `relative` container with a fixed height (e.g., 15 hours × 60px = 900px)
- Hour lines drawn as horizontal borders at 60px intervals
- Each slot is `absolute`, positioned: `top = (startHour - 8) * 60px`, `height = durationMinutes * 1px`
- Remove `HALF_HOURS`, `occupiedCells`, `slotsByDayAndHalfHour`, `getSlotRowSpan` — all unnecessary
- Keep `slotsByDayAndHour` only for mobile view

**Benefits:** Slots render at exact pixel positions matching their time, no gaps, no overflow, no row-span math.

### Compact Card Content (`CalendarSlotCard.tsx`)

Simplify the inline card to show only essentials (details on click via popover):
- Line 1: `10:00 - 11:00` + lock icon if marked full
- Line 2: Cyclus name (truncated)
- Line 3: `👤 2/4` + trainer name (if `showTrainerInfo`)
- Line 4: Rating badge (only if fits, i.e. slot is ≥60min)
- Remove the `rowSpan` prop — no longer needed

### Mobile View
Keep as-is (flat sorted list) — it already works well.

### Click behavior
No changes needed — popover already opens on click with full details and actions.

## Files changed

| File | Change |
|------|--------|
| `src/components/trainer/TrainerCalendarGrid.tsx` | Replace half-hour grid with absolute-positioned day columns |
| `src/components/trainer/CalendarSlotCard.tsx` | Remove `rowSpan` prop, keep card content compact |

~150 lines simplified in the grid, ~5 lines in the card.

