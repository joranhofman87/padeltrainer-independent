

## Fix: Use Trainer Slugs Instead of UUIDs in Player Dashboard

### Problem
The "Featured Trainers" section on the Player Dashboard links to `/book/{UUID}` instead of using the trainer's name-based slug. This is inconsistent with the rest of the platform.

### Root Cause
In `src/pages/PlayerDashboard.tsx`:
1. The `fetchFeaturedTrainers` query does NOT fetch the `slug` field from `trainer_profiles`
2. The card click handler uses `navigate('/book/${trainer.id}')` -- a raw UUID path -- instead of the marketing trainer profile path with slug

### Changes

**File: `src/pages/PlayerDashboard.tsx`**

1. Add `slug` to the `FeaturedTrainer` interface
2. Add `slug` to both `trainer_profiles` SELECT queries in `fetchFeaturedTrainers` (verified and fallback)
3. Change the Featured Trainer card `onClick` from:
   ```
   navigate(`/book/${trainer.id}`)
   ```
   to:
   ```
   navigate(getMarketingPath(`trainer/${trainer.slug || trainer.id}`))
   ```
   This links to the trainer's public profile (where they can then book), consistent with the rest of the site.

### No other files need changes
The other pages (`Trainers.tsx`, `TrainersCity.tsx`, `HomeFeaturedSections.tsx`, `LocationDetail.tsx`, `AcademyPublicProfile.tsx`) already correctly use the `slug || id` fallback pattern.
