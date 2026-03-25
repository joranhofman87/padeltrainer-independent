

# Show Trainer Open Slots on Academy Public Page

## Problem
Currently `AcademyPublicOpenSlots` only shows slots where `academy_profile_id` matches the academy. It misses public open slots from individual trainers linked to the academy via `academy_trainers`.

The internal management page (`AcademyOpenSlots`) already handles this correctly by first fetching trainer IDs from `academy_trainers`, then querying slots by `trainer_id`.

## Changes in `src/components/academy/AcademyPublicOpenSlots.tsx`

Update `fetchOpenSlots` to:

1. **Fetch academy trainer IDs** from `academy_trainers` where `status = 'active'`
2. **Query slots using an OR condition**: slots where `academy_profile_id = academyId` OR `trainer_id` is in the list of academy trainer IDs
3. Keep all existing filters (`is_public`, `is_marked_full`, `cyclus_id is null`, future dates)

This mirrors the pattern already used in the internal `AcademyOpenSlots` page. No other files need changes.

