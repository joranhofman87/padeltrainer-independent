
# Fix: KNLTB Rating Data Consistency Between Admin and Academy Views

## Problem Summary

Tygho has a KNLTB rating that shows correctly in the admin panel but not in the academy trainer edit dialog. This is because:

| Location | Data Source | Fields Used |
|----------|------------|-------------|
| **Admin Panel** | `profiles` table | `skill_rating`, `rating_system`, `rating_member_id` |
| **Academy Edit Dialog** | `trainer_profiles` table | `knltb_rating`, `trainer_rating_system` (legacy fields) |

**Database Evidence:**
- `profiles.skill_rating = 0.9`
- `profiles.rating_system = 'knltb'`
- `trainer_profiles.knltb_rating = NULL` (not used)

The rating data lives in the `profiles` table, but the Academy trainer edit dialog reads from `trainer_profiles`.

---

## Solution

Update the `EditAcademyTrainerDialog` to read and write rating data from the `profiles` table instead of `trainer_profiles`.

## Files to Modify

| File | Change |
|------|--------|
| `src/components/academy/EditAcademyTrainerDialog.tsx` | Read/write rating from `profiles` table instead of `trainer_profiles` |
| `src/lib/academy.ts` | Include rating fields when fetching profiles for trainers list |

---

## Implementation Details

### 1. Update EditAcademyTrainerDialog.tsx

**Current data model (incorrect):**
```typescript
interface TrainerProfileData {
  knltb_rating: number | null;          // Wrong source
  trainer_rating_system: string;        // Wrong source
  ...
}
```

**Fixed data model:**
```typescript
interface ProfileData {
  full_name: string;
  phone: string;
  bio: string;
  avatar_url: string | null;
  skill_rating: number | null;          // Add rating fields
  rating_system: string | null;
  rating_member_id: string | null;
}
```

**Current fetch (incorrect):**
```typescript
// Fetching from trainer_profiles
const { data: trainer } = await supabase
  .from('trainer_profiles')
  .select('..., knltb_rating, trainer_rating_system, ...')
```

**Fixed fetch:**
```typescript
// Fetch rating from profiles table
const { data: profile } = await supabase
  .from('profiles')
  .select('full_name, phone, bio, avatar_url, skill_rating, rating_system, rating_member_id')
  .eq('user_id', userId)
  .single();
```

**Current save (incorrect):**
```typescript
// Saving to trainer_profiles
await supabase
  .from('trainer_profiles')
  .update({ knltb_rating: ..., trainer_rating_system: ... })
```

**Fixed save:**
```typescript
// Save rating to profiles table
await supabase
  .from('profiles')
  .update({ 
    skill_rating: profileData.skill_rating,
    rating_system: profileData.rating_system,
    rating_member_id: profileData.rating_member_id,
    ...
  })
```

### 2. Update getAcademyTrainersWithProfiles (academy.ts)

**Current query (missing rating fields):**
```typescript
const { data: profiles } = await supabase
  .from('profiles_public')
  .select('user_id, full_name, avatar_url')  // Missing rating fields
  .in('user_id', userIds);
```

**Fixed query:**
```typescript
const { data: profiles } = await supabase
  .from('profiles_public')
  .select('user_id, full_name, avatar_url, skill_rating, rating_system')
  .in('user_id', userIds);
```

This allows the trainer cards to optionally display ratings in the future.

---

## Data Flow After Fix

```text
+------------------+     reads/writes     +------------------+
|   Admin Panel    | <------------------> |   profiles       |
| (skill_rating)   |                      | - skill_rating   |
+------------------+                      | - rating_system  |
                                          | - rating_member_id|
+------------------+     reads/writes     +------------------+
| Academy Trainer  | <------------------> |                  |
| Edit Dialog      |                      |                  |
+------------------+                      +------------------+
```

Both views now read/write from the same source (profiles table).

---

## Summary of Changes

1. **EditAcademyTrainerDialog.tsx**:
   - Move rating fields (`skill_rating`, `rating_system`, `rating_member_id`) to `ProfileData` interface
   - Remove `knltb_rating` and `trainer_rating_system` from `TrainerProfileData`
   - Update `fetchData()` to read rating from profiles query
   - Update `handleSubmit()` to save rating to profiles table

2. **academy.ts**:
   - Add `skill_rating, rating_system` to the profiles_public select in `getAcademyTrainersWithProfiles`
