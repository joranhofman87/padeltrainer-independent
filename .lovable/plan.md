

# Convert Experience Years to "Started Coaching Year"

## Problem
Trainers currently enter a static "years of experience" number which becomes outdated every year. Instead, we store the year they started coaching and calculate experience dynamically.

## Changes

### 1. Database Migration
- Add a new column `coaching_since_year` (integer, nullable) to `trainer_profiles`
- Migrate existing data: for the 6 trainers with `experience_years` set, calculate `coaching_since_year = 2026 - experience_years`
- Keep `experience_years` column for now (no breaking change), but stop writing to it

### 2. Update Trainer Edit Profile (`src/pages/EditProfile.tsx`)
- Replace the "Years of Experience" number input with a "Coaching since (year)" input
- Read/write `coaching_since_year` instead of `experience_years`
- Add the field to the select query

### 3. Update Academy Trainer Edit (`src/components/academy/EditAcademyTrainerDialog.tsx`)
- Same change: replace experience_years input with coaching_since_year

### 4. Update Admin Trainer Edit (`src/components/admin/TrainerEditDialog.tsx`)
- Same change for admin editing

### 5. Update Display Components
Everywhere `experience_years` is displayed, compute it from `coaching_since_year`:
- `src/components/profiles/ProfileHeroCard.tsx` -- already receives `experienceYears` as a prop, so the calculation happens at the caller level
- `src/pages/TrainerProfile.tsx` -- calculate `2026 - coaching_since_year` and pass as `experienceYears`
- `src/pages/BookLesson.tsx` -- same calculation
- `src/pages/Trainers.tsx` -- trainer card display
- `src/lib/locations.ts` -- location detail trainer list
- `src/hooks/useAdminData.ts` -- admin data types/queries

### 6. Update Data Fetching
Add `coaching_since_year` to all queries that currently fetch `experience_years`:
- `src/pages/EditProfile.tsx`
- `src/pages/Trainers.tsx`
- `src/pages/BookLesson.tsx`
- `src/lib/locations.ts`
- `src/lib/auth.ts`
- `src/hooks/useAdminData.ts`

## Migration Data
Current data (6 trainers):
| experience_years | count | coaching_since_year |
|-----------------|-------|-------------------|
| 5               | 4     | 2021              |
| 12              | 1     | 2014              |
| 16              | 1     | 2010              |

## Technical Notes
- A helper function `getExperienceYears(coachingSinceYear: number | null): number | null` using `new Date().getFullYear() - coachingSinceYear` ensures the calculation is always based on the current year
- The `experience_years` column is kept but no longer written to, avoiding breaking any existing queries during transition
