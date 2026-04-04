

# Build Academy Calendar Day Grid with Drag-and-Drop

## Overview
Replace the current `TrainerCalendarGrid` in the Academy Calendar with a new `AcademyDayGrid` component that mirrors the ProposalScheduleGrid layout: day tabs, trainer columns, slot cards with player chips, a player sidebar, and drag-and-drop to move/add/remove players. Week and month views become simplified read-only overviews.

**No data model changes. No backend changes. Purely frontend.**

## New files

### 1. `src/components/academy/AcademyDayGrid.tsx` (~600 lines)
The main interactive component using `@dnd-kit`. Adapts ProposalScheduleGrid patterns for the bookings data model.

**Layout:**
- **Day tabs** (Mon–Sun) with player counts per day
- **Search bar** to filter/highlight players
- **Time-row x Trainer-column grid** (30-min increments, same CSS grid pattern as ProposalScheduleGrid)
- **Slot cards** with: time range, occupancy badge, rating range, player chips
- **Draggable player chips** inside slots — drop onto another slot to move booking (`UPDATE bookings SET slot_id`)
- **Player sidebar** (collapsible) showing all known players, searchable, draggable into open slots

**Data mapping (calendar → ProposalScheduleGrid equivalents):**
| Calendar concept | ProposalScheduleGrid equivalent |
|---|---|
| `BookedPlayer` | `Assignment` |
| `booking.id` | `assignment.id` |
| `booking.slot_id` | `assignment.slot_id` |
| `SlotWithBookings` | `SlotWithOccupancy` |
| booking status (confirmed/pending) | confidence_score |
| All historical players | `UnplacedPlayer[]` |

**Drag-and-drop operations:**
- **Move player between slots**: `UPDATE bookings SET slot_id = $newSlotId WHERE id = $bookingId`
- **Add player from sidebar**: Opens existing `BookForPlayerDialog` or direct booking insert
- **Remove player (drop to sidebar)**: Cancels/deletes the booking
- Reuses same `DndContext`, `PointerSensor`, `DragOverlay` patterns

### 2. `src/components/academy/AcademyWeekOverview.tsx` (~150 lines)
Simplified read-only week view. Shows 7 day columns with compact slot summary cards (time, trainer avatar, occupancy count). Click a day to switch to day view for that date.

## Modified files

### 3. `src/pages/academy/AcademyCalendar.tsx`
- Replace `TrainerCalendarGrid` with `AcademyDayGrid` for day view
- Replace `TrainerCalendarGrid` with `AcademyWeekOverview` for week view (month keeps simple card grid)
- Add `allKnownPlayers` state — fetched from all historical bookings + guest_players for the academy's trainers
- Add `handleMovePlayer(bookingId, newSlotId)` — updates booking's slot_id
- Add `handleRemovePlayer(bookingId)` — deletes/cancels booking
- Keep all existing dialogs (BulkCreateSheet, DeleteSlot, EditBooking, BookForPlayer)
- `fetchSlots` already fetches bookings with player data — just pass through to new components

## Implementation order
1. Build `AcademyDayGrid` with static layout (day tabs, trainer columns, slot cards, player chips)
2. Wire drag-and-drop for moving players between slots
3. Add player sidebar with historical player fetch + drag-to-add
4. Build `AcademyWeekOverview`
5. Update `AcademyCalendar.tsx` to use new components

## What stays the same
- All existing slots and bookings data untouched
- Slot creation via `BulkCreateSheet`
- Delete/edit dialogs
- Trainer/location filters
- Date navigation
- `fetchSlots()` data fetching logic (already has everything needed)

