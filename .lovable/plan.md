

# Replace Textual Levels with Rating System Min/Max on Slots

## Current State
- `availability_slots` has a single `training_level` text column with values "beginner", "intermediate", "advanced"
- Only used in the **cyclus (bulk) creation** form in `AddSlotDialog.tsx` (lines 1174-1193)
- Not used in `EditSlotDialog`, `ClubAddSlotDialog`, `CalendarSlotCard`, or `ClubSlotDetailSheet`
- The proposal engine (`generate-proposals`) already uses trainer-level rating preferences (`preferred_min_rating`/`preferred_max_rating`/`preferred_rating_system` on `trainer_profiles`) but does NOT read `training_level` from slots

## Plan

### 1. Database Migration
Add three new columns to `availability_slots`, deprecate the old one:
```sql
ALTER TABLE availability_slots
  ADD COLUMN rating_system text DEFAULT NULL,
  ADD COLUMN min_rating numeric DEFAULT NULL,
  ADD COLUMN max_rating numeric DEFAULT NULL;

COMMENT ON COLUMN availability_slots.rating_system IS 'Rating system code (e.g. knltb, playtomic)';
COMMENT ON COLUMN availability_slots.min_rating IS 'Minimum player rating for this slot (inclusive)';
COMMENT ON COLUMN availability_slots.max_rating IS 'Maximum player rating for this slot (inclusive)';
```

### 2. Trainer Slot Creation — `AddSlotDialog.tsx`
- Replace the "Training Level" dropdown (beginner/intermediate/advanced) with a **Rating System** selector + **Min Rating** and **Max Rating** number inputs
- The rating system dropdown pulls from the existing `ratingSystems` data (same source as `TrainerFilters`)
- When a system is selected, show min/max inputs with the system's `min_rating`/`max_rating` range and `step` as constraints
- Update `BulkSlotConfig` interface: replace `trainingLevel: string | null` with `ratingSystem: string | null`, `minRating: number | null`, `maxRating: number | null`
- Map to new DB columns on insert

### 3. Trainer Single Slot Creation (one-time slot)
- Add the same optional rating system + min/max fields to the single-slot creation form
- Currently single slots have no level field at all, so this is purely additive

### 4. Edit Slot Dialog — `EditSlotDialog.tsx`
- Add the rating system + min/max fields so trainers can update levels on existing slots

### 5. Club Dialogs — `ClubAddSlotDialog.tsx`
- Add the same rating fields to both single and cyclus creation for clubs

### 6. Display — `CalendarSlotCard.tsx` and `ClubSlotDetailSheet.tsx`
- When a slot has `rating_system` + `min_rating`/`max_rating`, show a compact badge like "KNLTB 4.0–6.0" or "Playtomic ≥3.0"
- Fetch `rating_system` in the `SlotWithBookings` interface

### 7. Booking Page
- Show the level requirement on the booking page so players know if a session matches their rating

### 8. Proposal Engine (future-ready)
- The `generate-proposals` edge function already checks trainer rating preferences. The new slot-level min/max could be used for even more precise matching in the future — no changes needed now unless requested.

## Data Flow
```text
Trainer creates slot → selects "KNLTB" + min 4.0 + max 6.0
                     → stored as rating_system='knltb', min_rating=4.0, max_rating=6.0
                     → displayed on calendar card as "KNLTB 4.0–6.0"
                     → shown on booking page to players
```

## Files to Change
| File | Change |
|------|--------|
| DB migration | Add `rating_system`, `min_rating`, `max_rating` columns |
| `src/components/trainer/AddSlotDialog.tsx` | Replace textual level with rating system + min/max inputs |
| `src/components/trainer/EditSlotDialog.tsx` | Add rating system + min/max fields |
| `src/components/club/ClubAddSlotDialog.tsx` | Add rating system + min/max fields |
| `src/components/trainer/CalendarSlotCard.tsx` | Display rating range badge |
| `src/components/club/ClubSlotDetailSheet.tsx` | Display rating range |
| `src/lib/ratingSystems.ts` | No changes needed — already provides all required data |

