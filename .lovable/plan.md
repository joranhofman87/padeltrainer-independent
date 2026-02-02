
# Data Consistency Fix: Academy Trainer Edit Dialog

## Problem Summary

The same trainer shows different data in Admin vs Academy edit dialogs because:

| Admin Panel | Academy Dialog |
|-------------|----------------|
| ✅ Reads from `profiles` table (RLS allows admins) | ❌ Reads from `profiles` table (RLS blocks academy managers) |
| ✅ Saves via `update-user` edge function | ❌ Saves directly to `profiles` (blocked by RLS) |
| Shows: "Tygho Schoonus", KNLTB 0.9 | Shows: "John Doe" (placeholder), 8.0 (default) |

---

## Root Cause

The `EditAcademyTrainerDialog` directly queries the `profiles` table:
```typescript
const { data: profile } = await supabase
  .from('profiles')  // <-- RLS restricts this!
  .select('...')
  .eq('user_id', userId)
```

RLS policy on `profiles`:
- Admins can view all
- Users can view their own
- Academy managers **cannot** view other users' profiles

The query silently returns `null`, so the dialog shows empty/placeholder values.

---

## Solution

### 1. Update `profiles_public` View

Add missing fields needed for trainer editing:
- `phone`
- `rating_member_id` (currently only has `knltb_number`)

```sql
CREATE OR REPLACE VIEW profiles_public AS
SELECT 
  id, user_id, full_name, avatar_url, bio, location,
  skill_rating, rating_system, rating_member_id,
  phone,  -- Add phone
  created_at, updated_at
FROM profiles;
```

### 2. Update `EditAcademyTrainerDialog.tsx` - Fetch Logic

Change from `profiles` table to `profiles_public` view:

```typescript
// Before (broken)
const { data: profile } = await supabase
  .from('profiles')
  .select('full_name, phone, bio, avatar_url, skill_rating, rating_system, rating_member_id')
  .eq('user_id', userId);

// After (works)
const { data: profile } = await supabase
  .from('profiles_public')
  .select('full_name, phone, bio, avatar_url, skill_rating, rating_system, rating_member_id')
  .eq('user_id', userId);
```

### 3. Update `update-user` Edge Function

Extend to allow academy managers (not just admins) to update trainers in their academy:

```typescript
// Check if caller is admin OR academy manager for this trainer
const isAdmin = !!adminRole;

// Check if academy manager for this trainer
let isAcademyManagerForTrainer = false;
if (!isAdmin) {
  // Get trainer's academy membership
  const { data: trainerAcademy } = await supabaseAdmin
    .from('academy_trainers')
    .select('academy_profile_id')
    .eq('trainer_profile_id', trainer_profile_id) // Need to pass this
    .eq('status', 'active')
    .maybeSingle();

  if (trainerAcademy) {
    // Check if caller is manager of that academy
    const { data: managerCheck } = await supabaseAdmin
      .from('academy_managers')
      .select('id')
      .eq('user_id', adminUser.id)
      .eq('academy_profile_id', trainerAcademy.academy_profile_id)
      .maybeSingle();
    
    isAcademyManagerForTrainer = !!managerCheck;
  }
}

if (!isAdmin && !isAcademyManagerForTrainer) {
  return { error: "Unauthorized" };
}
```

### 4. Update `EditAcademyTrainerDialog.tsx` - Save Logic

Use the `update-user` edge function instead of direct Supabase updates:

```typescript
// Before (blocked by RLS)
const { error } = await supabase
  .from('profiles')
  .update({ full_name, skill_rating, ... })
  .eq('user_id', userId);

// After (uses edge function with service role)
const { error } = await supabase.functions.invoke("update-user", {
  body: {
    target_user_id: userId,
    trainer_profile_id: trainerId, // Needed for academy manager auth
    full_name: profileData.full_name,
    phone: profileData.phone,
    bio: profileData.bio,
    skill_rating: profileData.skill_rating,
    rating_system: profileData.rating_system,
    rating_member_id: profileData.rating_member_id,
  },
});
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `supabase migration` | Add `phone` and `rating_member_id` to `profiles_public` view |
| `supabase/functions/update-user/index.ts` | Add academy manager authorization check |
| `src/components/academy/EditAcademyTrainerDialog.tsx` | Use `profiles_public` for reads, edge function for writes |
| `src/components/club/EditClubTrainerDialog.tsx` | Same pattern as academy dialog |

---

## Data Flow After Fix

```text
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Admin Panel    │      │ Academy Dialog  │      │ Trainer's Own   │
│  TrainerEdit    │      │ EditAcademy     │      │ EditProfile     │
│  Dialog         │      │ TrainerDialog   │      │                 │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │                        │                        │
         ▼                        ▼                        ▼
    ┌────────────────────────────────────────────────────────────┐
    │                    profiles_public VIEW                     │
    │         (full_name, skill_rating, rating_system, phone)     │
    └────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ (READ)
    ┌────────────────────────────────────────────────────────────┐
    │                       profiles TABLE                        │
    │              (all fields, RLS protected)                    │
    └────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ (WRITE via service role)
    ┌────────────────────────────────────────────────────────────┐
    │                   update-user Edge Function                 │
    │    (validates: admin OR academy manager OR own profile)     │
    └────────────────────────────────────────────────────────────┘
```

---

## Result

After implementation:
- All three views (Admin, Academy, Trainer) show identical data
- All three can update the same profile fields
- Rating system, skill rating, and member ID are consistent everywhere
- Academy managers can edit their trainers' profiles without admin access
