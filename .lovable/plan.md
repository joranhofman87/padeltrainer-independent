

# Unified Slot Detail Dialog + Overview Improvements

## Problems
1. **No "marked full/private" indicator** on overview — dots show occupancy but don't reveal locked slots
2. **Clicking a slot in overview** navigates to the Manage tab's day view, losing context — user has to find the slot again
3. **Edit booking error on Manage tab** — `handleEditBooking` query is missing `paid_externally`, `price_per_session`, and `cyclus_name` fields that `EditBookingDialog` expects
4. **Fragmented editing** — every tab pushes to Manage or opens different dialogs, no unified "view slot details + edit" flow

## Solution: Slot Detail Dialog accessible from anywhere

Instead of tab-hopping, clicking any slot (from Overview, Open Spots, or Manage) opens a single **SlotDetailDialog** that shows all slot info and provides edit actions inline.

### 1. New `SlotDetailDialog.tsx` — Unified slot detail + edit panel

A dialog/sheet that receives a `slotId` and fetches full details:

**Read-only section (top):**
- Date, time, trainer (avatar + name), location
- Cyclus name (if part of one) — links to cycle detail
- Occupancy: player list with names
- Lock icon + "Private" badge if `is_marked_full`
- Price per session, rating range

**Action buttons:**
- "Edit Slot" → opens existing `EditSlotDialog`
- "Delete" → opens existing `DeleteSlotDialog`  
- "Add Player" → opens existing `BookForPlayerDialog`
- Per-player: click to edit booking → opens existing `EditBookingDialog`
- Toggle "Mark as Private" inline

This dialog reuses ALL existing dialogs — it's just an entry point / detail view.

### 2. `AcademyCalendarOverview.tsx` — Show private indicator + wire slot click

**Private/locked indicator:**
- Add a small Lock icon next to the time in `TrainerDayBlock` when `slot.is_marked_full === true`
- Update legend to include "🔒 Private (not shown to players)"

**Click behavior:**
- Change `onClick` on individual slot rows to call a new `onSlotClick(slotId)` prop instead of `onDayClick`
- Keep day header click as `onDayClick` (navigates to Manage day view)

### 3. `AcademyCalendar.tsx` — Wire SlotDetailDialog + fix edit booking bug

**Wire `onSlotClick`:**
- Add `SlotDetailDialog` to the dialogs section
- Add `handleSlotClick(slotId)` that opens the detail dialog
- Pass `onSlotClick` to `AcademyCalendarOverview`

**Fix edit booking query (line 540):**
- Add `paid_externally` to the select
- Change `availability_slots (id, start_time, end_time)` to `availability_slots (id, start_time, end_time, price_per_session, cyclus_name)`

### 4. `AcademyOpenSlots.tsx` — Wire slot click to same dialog

- Add `onSlotClick` callback that opens the same `SlotDetailDialog`
- Individual slot cards and cyclus slot rows become clickable

## File summary

| File | Change |
|------|--------|
| `src/components/academy/SlotDetailDialog.tsx` | **New** — Unified slot detail view with action buttons |
| `src/components/academy/AcademyCalendarOverview.tsx` | Add Lock icon for private slots, add `onSlotClick` prop, update legend |
| `src/pages/academy/AcademyCalendar.tsx` | Wire `SlotDetailDialog`, fix `handleEditBooking` query, pass `onSlotClick` to Overview |
| `src/pages/academy/AcademyOpenSlots.tsx` | Make slot rows clickable → open `SlotDetailDialog` |

