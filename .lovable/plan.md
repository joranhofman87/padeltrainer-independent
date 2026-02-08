

# General Terms Feature

## Overview
Add the ability for trainers and academies to manage their own "General Terms" (Algemene Voorwaarden). Players must accept these terms when booking a lesson or signing up for a cycle. If a trainer belongs to an academy, the academy's terms apply instead of the trainer's own.

## What Changes

### 1. Database
- Add a `general_terms` text column to `trainer_profiles` (nullable, for trainers' own terms)
- Add a `general_terms` text column to `academy_profiles` (nullable, for academy-wide terms)

### 2. Trainer Settings -- New "General Terms" card
- Add a new settings card on the Trainer Settings page (alongside Subscription, Profile, etc.) linking to a new page `/app/trainer/terms`
- New page: `TrainerTerms.tsx` -- a simple form with a rich text editor (TipTap, already installed) to write/edit their general terms, with a save button
- If the trainer is part of an academy, show a read-only notice that the academy's terms apply, with the academy terms displayed

### 3. Academy Settings -- New "General Terms" section
- Add a new card on `AcademySettings.tsx` with a TipTap rich text editor for the academy's general terms

### 4. Booking Flow -- Accept Terms
- On `BookLesson.tsx`: before the player can confirm a booking, fetch the applicable terms (academy terms if trainer is in academy, otherwise trainer terms). If terms exist, show them in a scrollable area with a checkbox "I accept the general terms". Block booking until accepted.
- On `CycleApplicationForm.tsx`: same logic -- fetch the terms for the cycle owner (trainer or academy) and require acceptance alongside the existing consent checkbox.

### 5. Terms Resolution Logic
- New helper function `getApplicableTerms(trainerProfileId)` in a lib file that:
  1. Checks if the trainer belongs to an academy (via `academy_trainers` table)
  2. If yes, returns the academy's `general_terms`
  3. If no, returns the trainer's own `general_terms`
  4. Returns `null` if no terms are set

## Technical Details

### Database Migration
```sql
ALTER TABLE public.trainer_profiles ADD COLUMN general_terms text;
ALTER TABLE public.academy_profiles ADD COLUMN general_terms text;
```

No new RLS policies needed -- existing policies on these tables already allow owners to update their own profiles, and terms will be read publicly (same as other profile fields).

### New Files
- `src/pages/TrainerTerms.tsx` -- Terms editing page for trainers
- `src/lib/terms.ts` -- Helper to resolve applicable terms for a trainer

### Modified Files
- `src/pages/TrainerSettings.tsx` -- Add "General Terms" settings card
- `src/pages/academy/AcademySettings.tsx` -- Add terms editor card
- `src/pages/BookLesson.tsx` -- Add terms acceptance before booking
- `src/components/cycles/CycleApplicationForm.tsx` -- Add terms acceptance
- `src/components/DomainRouter.tsx` -- Add route for `/app/trainer/terms`
- Translation files (en/nl) for trainer and academy namespaces

### Route
- `/app/trainer/terms` -- nested under TrainerLayout

