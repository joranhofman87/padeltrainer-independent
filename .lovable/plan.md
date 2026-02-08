

## Enhance BulkCreateSheet: Remove Lesson, Add Pricing and Participant Controls

### What Changes

1. **Remove the "Lesson" (Koppel aan Les) field** from the cyclus creation sheet -- it's not needed since pricing comes from the trainer's hourly rate.

2. **Show pricing based on trainer's hourly rate**: Display the price per hour and total cyclus price, calculated from the selected trainer's `hourly_rate` and session duration/count. Both values are editable so the academy can adjust.

3. **"Allow single slot booking" checkbox**: Default off. When enabled, players can book and pay for individual slots from the cyclus instead of the full cycle.

4. **Min + max participants per cyclus/slot**: Two number inputs for minimum and maximum number of players.

### Database Migration

Add new columns to `availability_slots`:

```sql
ALTER TABLE public.availability_slots
  ADD COLUMN price_per_session numeric DEFAULT NULL,
  ADD COLUMN total_price numeric DEFAULT NULL,
  ADD COLUMN allow_single_booking boolean DEFAULT false,
  ADD COLUMN min_participants integer DEFAULT NULL,
  ADD COLUMN max_participants integer DEFAULT NULL;
```

These are stored per-slot so each generated slot in a cyclus carries its pricing and participant rules.

### Technical Details

**File: `src/components/trainer/AddSlotDialog.tsx`**

- Update `BulkSlotConfig` interface to add: `pricePerSession`, `totalPrice`, `allowSingleBooking`, `minParticipants`, `maxParticipants`
- Remove `lessonId` from the config and remove the lesson selector UI
- Remove `lessons` from `BulkCreateSheetProps` (and `AddSlotDialogProps` if only used here)
- When a trainer is selected (or pre-set), fetch their `hourly_rate` from `trainer_profiles`
- Auto-calculate: `pricePerSession = (hourlyRate / 60) * durationMinutes` and `totalPrice = pricePerSession * recurrenceWeeks`
- Show both as editable number inputs so the user can override
- Recalculate when duration, weeks, or trainer changes (but not if user manually edited)
- Add the "Allow single slot booking" checkbox (default unchecked)
- Add min/max participants number inputs
- Update `generateBulkSlots` to include the new fields in the insert payload and remove `lesson_id`

**Files: `src/pages/TrainerCalendar.tsx` and `src/pages/academy/AcademyCalendar.tsx`**

- Stop passing `lessons` prop to `BulkCreateSheet` (cleanup)

**File: `src/components/trainer/AddSlotDialog.tsx` (AddSlotDialog)**

- The single-slot `AddSlotDialog` can keep the lesson field for now (separate scope)

### UI Layout in the Sheet

After the Trainer / Location / Court Type / Training Level fields:

```text
-- Pricing --
Price per session:  [auto-calculated, editable]  (e.g. EUR 40.00)
Total cyclus price: [auto-calculated, editable]  (e.g. EUR 320.00)

-- Participants --
Min participants:   [number input]
Max participants:   [number input]

-- Booking --
[x] Allow players to book individual slots
    (When enabled, players can book and pay for single sessions)
```

The cyclus name, players, and private toggle remain below as they are now.
