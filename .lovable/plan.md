

# Fix: Trainer Rating Display Using Wrong Data Source

## Problem Summary
The admin panel saves trainer ratings to the `profiles` table (`skill_rating`, `rating_system`, `rating_member_id`), but the trainer's EditProfile page reads from the `trainer_profiles` table (`knltb_rating`, `trainer_rating_system`). These are two separate fields.

**Database values for Rene:**
| Table | Field | Value |
|-------|-------|-------|
| profiles | skill_rating | 1.0 |
| profiles | rating_system | knltb |
| trainer_profiles | knltb_rating | NULL |
| trainer_profiles | trainer_rating_system | knltb |

The admin correctly set `profiles.skill_rating = 1.0`, but the trainer sees `trainer_profiles.knltb_rating = NULL`.

## Solution
Update the trainer's EditProfile page to use the shared `formData` (from the `profiles` table) instead of `trainerData` for the rating section. This aligns with the existing architecture where ratings live in the `profiles` table for both players and trainers.

## Files to Change

| File | Changes |
|------|---------|
| `src/pages/EditProfile.tsx` | Change Trainer Details rating section to use `formData.skill_rating` and `formData.rating_system` instead of `trainerData.knltb_rating` and `trainerData.trainer_rating_system` |

## Implementation Details

In the "Your Padel Rating" section within Trainer Details (lines 885-943):

1. Change the rating system Select from:
   - `value={trainerData.trainer_rating_system}` 
   - to `value={formData.rating_system}`

2. Change the rating Input from:
   - `value={trainerData.knltb_rating || ''}`
   - to `value={formData.skill_rating}`

3. Update the onChange handlers to modify `formData` instead of `trainerData`

4. Use `currentRatingSystem` (already computed from `formData.rating_system`) for the constraints

This ensures both admin and trainer are reading from and writing to the same `profiles` table fields.

## Before/After

**Before:**
```text
Admin saves → profiles.skill_rating = 1.0
Trainer sees ← trainer_profiles.knltb_rating = NULL
```

**After:**
```text
Admin saves → profiles.skill_rating = 1.0
Trainer sees ← profiles.skill_rating = 1.0
```

