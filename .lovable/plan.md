

# Legacy Rating Fields Cleanup Plan

## Overview

The rating system has been migrated to use the `profiles` table (`skill_rating`, `rating_system`, `rating_member_id`) instead of legacy fields in `trainer_profiles` (`knltb_rating`, `trainer_rating_system`). This cleanup removes all legacy references from the codebase.

---

## Scope of Changes

| File | Legacy Fields Used | Action |
|------|-------------------|--------|
| `src/pages/EditProfile.tsx` | `knltb_rating`, `trainer_rating_system` in interface/fetch/save | Remove from TrainerProfileData, stop fetching/saving |
| `src/components/club/EditClubTrainerDialog.tsx` | Same pattern | Update to use profiles table like academy dialog |
| `src/pages/Trainers.tsx` | Uses for filtering | Update filter logic to use `profile.skill_rating` + `profile.rating_system` |
| `src/pages/TrainersCity.tsx` | Displays `knltb_rating` | Update to use `profile.skill_rating` + `profile.rating_system` |
| `src/pages/LocationDetail.tsx` | In Trainer interface | Update interface, already joins with profiles |

---

## Detailed Changes

### 1. EditProfile.tsx (Trainer's own profile page)

**Current (legacy):**
- Interface has `knltb_rating`, `trainer_rating_system`
- Fetches from `trainer_profiles` table
- Saves to `trainer_profiles` table

**After cleanup:**
- Remove these fields from `TrainerProfileData` interface
- Remove from `fetchTrainerProfile()` select query
- Remove from `handleSubmit()` update query
- Rating is already correctly handled via `formData.skill_rating`, `formData.rating_system` → saved to `profiles` table

### 2. EditClubTrainerDialog.tsx (Club editing a trainer)

**Current (legacy):**
- Same pattern as EditProfile - reads/writes rating to trainer_profiles

**After cleanup:**
- Add `skill_rating`, `rating_system`, `rating_member_id` to ProfileData interface
- Read from profiles table
- Save to profiles table
- Remove legacy fields from TrainerProfileData
- Match the pattern already used in `EditAcademyTrainerDialog`

### 3. Trainers.tsx (Public trainer listing with filters)

**Current (legacy):**
```typescript
interface Trainer {
  knltb_rating: number | null;
  trainer_rating_system: string | null;
  profile: {
    skill_rating: number | null;  // Already has correct field!
    rating_system: string | null; // Already has correct field!
  }
}
```

The page fetches from `trainer_profiles_safe` but also joins with `profiles_public` which has the correct data.

**After cleanup:**
- Remove `knltb_rating`, `trainer_rating_system` from interface
- Update filter logic to use `trainer.profile?.skill_rating` and `trainer.profile?.rating_system`
- Remove legacy fields from the select query

### 4. TrainersCity.tsx (City-specific trainer listing)

**Current (legacy):**
- Displays `trainer.knltb_rating` directly in UI
- Interface has `knltb_rating` but no `trainer_rating_system`

**After cleanup:**
- Update interface to get rating from profile
- Update display to show `profile.skill_rating` with proper rating system label
- Join with profiles_public to get rating data

### 5. LocationDetail.tsx (Location page showing trainers)

**Current (legacy):**
- Trainer interface has `knltb_rating`

**After cleanup:**
- Remove `knltb_rating` from interface
- Rating data should come from joined profiles

---

## Database Note

The `trainer_profiles_safe` view still includes `knltb_rating` and `trainer_rating_system` columns. These can remain in the view for now (backward compatibility) - the columns exist in the table but are no longer used. A future migration could remove them from the table entirely, but that's a separate concern from this code cleanup.

---

## Summary of File Changes

| File | Changes |
|------|---------|
| `src/pages/EditProfile.tsx` | Remove `knltb_rating`, `trainer_rating_system` from interface, fetch, and save |
| `src/components/club/EditClubTrainerDialog.tsx` | Add rating fields to ProfileData, read/write to profiles table, remove from TrainerProfileData |
| `src/pages/Trainers.tsx` | Update interface and filter logic to use `profile.skill_rating`/`profile.rating_system` |
| `src/pages/TrainersCity.tsx` | Update interface and display to use profile rating fields |
| `src/pages/LocationDetail.tsx` | Remove `knltb_rating` from interface |

---

## Result

After cleanup:
- All rating data flows through `profiles` table
- `skill_rating`, `rating_system`, `rating_member_id` are the canonical fields
- Admin, Academy, Club, and Trainer views all read/write from the same source
- Legacy `knltb_rating` and `trainer_rating_system` fields in `trainer_profiles` table become unused

