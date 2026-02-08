

# Slot Booking Mode: Full Slot, Individual, or Flexible

## Overview
Add a **booking mode** setting per lesson type that controls how players can book spots. This fixes the current issue where individual players are charged the full lesson price instead of a per-person share.

## How it works

### Trainer Side (Lesson Management)
When creating or editing a lesson, trainers see a new "Booking mode" dropdown with three options:

- **Full slot only** -- Players must book the entire slot (all spots). They pay the full lesson price. Good for private lessons or when a group wants to reserve the whole session.
- **Individual spots** -- Players book exactly 1 spot. They pay the lesson price divided by max participants (e.g. EUR 80 / 4 = EUR 20 per person). Good for open group sessions.
- **Flexible (choose spots)** -- Players choose how many spots to book (1 to remaining available). Price per spot is auto-calculated the same way. Good for friends booking together.

Default for new lessons: **Full slot only** (preserves current behavior).
Existing lessons: automatically set to **Full slot only** so nothing changes for current trainers.

### Player Side (Booking Page)
- **Full slot only**: Player sees the full price. Clicking "Book" reserves all spots.
- **Individual spots**: Player sees the per-person price (e.g. "EUR 20 / spot"). Clicking "Book" reserves 1 spot.
- **Flexible**: Player sees a quantity selector (1-N remaining spots) and the per-spot price. Total updates as they change quantity.

### Trainer Dashboard (Open Slots / Book for Player)
The trainer's own "Book for Player" dialog already supports selecting multiple players -- no change needed there. The open slots page will show the booking mode as a small badge so trainers can see at a glance.

## Technical Details

### 1. Database Migration
Add a `booking_mode` column to the `lessons` table:

```sql
ALTER TABLE public.lessons
  ADD COLUMN booking_mode text NOT NULL DEFAULT 'full_slot';
```

Valid values: `full_slot`, `individual`, `flexible`. No enum needed -- enforced at app level.

### 2. Lesson Management (TrainerLessons.tsx + lib/lessons.ts)
- Add `booking_mode` to the `Lesson` type and CRUD functions
- Add a Select dropdown in the lesson create/edit form (only shown when `max_participants > 1`)
- For lessons with `max_participants = 1`, force `full_slot` and hide the option

### 3. Player Booking Page (BookLesson.tsx)
- Fetch `booking_mode` alongside other lesson fields from `availability_slots -> lessons`
- Adjust price display logic:
  - `full_slot`: show `lessons.price` (current behavior)
  - `individual` / `flexible`: show `lessons.price / max_participants` as per-spot price
- For `flexible` mode: add a quantity picker (number input or stepper, 1 to spotsLeft)
- For `individual`: quantity is always 1
- For `full_slot`: quantity = max_participants (book all spots)
- Adjust the booking insert to create the right number of booking rows
- Adjust the Mollie payment amount to: `perSpotPrice x quantity`

### 4. Public Trainer Profile (TrainerOpenSlots.tsx)
- Fetch and display the booking mode
- Show per-spot price when mode is `individual` or `flexible` (e.g. "EUR 20/spot" instead of "EUR 80")

### 5. Open Slots Page (OpenSlots.tsx)
- Show booking mode badge on each slot for trainer awareness

### 6. Club Lessons Page (ClubLessons.tsx)
- Add the same booking mode dropdown to the club lesson management form for consistency

### Files Modified
- `src/lib/lessons.ts` -- add `booking_mode` to Lesson type
- `src/pages/TrainerLessons.tsx` -- add booking mode selector to form
- `src/pages/BookLesson.tsx` -- pricing logic, quantity picker, booking creation
- `src/components/trainer/TrainerOpenSlots.tsx` -- show per-spot pricing
- `src/pages/OpenSlots.tsx` -- show booking mode badge
- `src/pages/club/ClubLessons.tsx` -- add booking mode selector
- Database migration: add `booking_mode` column to `lessons`

