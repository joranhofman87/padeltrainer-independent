

# Show Player Names & Actions on Academy Calendar

## Problem
The academy calendar shows booking **counts** (e.g. "2/4 geboekt") but always shows "Empty slot" for all player positions because:

1. **No player data fetched** — `AcademyCalendar.tsx` only queries `bookings` with `slot_id, status` (no player/guest_player joins)
2. **`booked_players: []` hardcoded** — line 290 always sets an empty array
3. **Missing RLS policy** — no policy allows academy managers to SELECT from `bookings` for their trainers' slots

## Plan

### 1. Add RLS policy for academy managers on bookings (migration)
Allow academy managers to SELECT bookings where the slot belongs to one of their academy's trainers:
```sql
CREATE POLICY "Academy managers can view bookings for their trainers slots"
ON public.bookings FOR SELECT
USING (
  slot_id IN (
    SELECT s.id FROM availability_slots s
    WHERE s.trainer_id IN (
      SELECT at.trainer_profile_id FROM academy_trainers at
      WHERE at.status = 'active'
      AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  )
);
```

### 2. Update `AcademyCalendar.tsx` fetch to include player data
In `fetchSlots`, expand the bookings query to include player info (same pattern as `TrainerCalendar.tsx`):
- Join `profiles:player_id` and `guest_players:guest_player_id` with names and ratings
- Build `BookedPlayer[]` arrays per slot
- Pass them into the mapped `SlotWithBookings` instead of `booked_players: []`

### 3. Wire up booking action callbacks
Pass `onBookForPlayer`, `onDeleteSlot`, `onEditBooking`, `onToggleMarkedFull`, and `onDuplicateCyclus` callbacks from `AcademyCalendar` to `TrainerCalendarGrid`, same as the trainer calendar does. Add the corresponding dialog components (`BookForPlayerDialog`, `DeleteSlotDialog`, `EditBookingDialog`).

| File | Change |
|------|--------|
| Migration SQL | Add academy manager SELECT policy on bookings |
| `src/pages/academy/AcademyCalendar.tsx` | Fetch player data in bookings query, build `booked_players`, add action callbacks + dialogs |

