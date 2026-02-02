

# Fix: Academy Managers Cannot Save Trainer Profile Changes

## Problem Identified

When an academy manager edits a trainer's profile (e.g., adding experience), the changes are **not being saved**. This happens because:

| Table | Fields | Can Academy Manager Update? |
|-------|--------|---------------------------|
| `profiles` | name, phone, bio, skill_rating | Yes (via edge function) |
| `trainer_profiles` | experience_years, hourly_rate, certifications | **NO - Missing RLS policy** |

The edge function logs show `"User updated... (manager)"` which means the profile fields save correctly, but the trainer-specific fields like **experience years** fail silently because there's no RLS policy allowing academy managers to update `trainer_profiles`.

## Current RLS Policies on `trainer_profiles`

```text
UPDATE policies:
- "Admins can update any trainer profile"
- "Club managers can update trainer profiles at their locations"  
- "Trainers can update their own trainer profile"

MISSING:
- "Academy managers can update trainer profiles in their academy"
```

---

## Solution

### Option A: Add RLS Policy for Academy Managers (Recommended)

Add a new UPDATE policy on `trainer_profiles` that allows academy managers to update trainers associated with their academy:

```sql
CREATE POLICY "Academy managers can update trainer profiles in their academy"
  ON public.trainer_profiles FOR UPDATE
  USING (
    id IN (
      SELECT at.trainer_profile_id
      FROM academy_trainers at
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );
```

This is the cleanest solution because it uses the same pattern as the existing club manager policy.

### Option B: Route Through Edge Function

Alternatively, we could extend the `update-user` edge function to also handle trainer_profiles updates. However, this adds complexity and the RLS approach is more consistent with how club managers already work.

---

## Implementation Plan

### 1. Database Migration
Add the missing RLS policy to allow academy managers to update `trainer_profiles` for trainers in their academy.

### 2. Also Add SELECT Policy (for consistency)
Academy managers should be able to read trainer profiles for trainers in their academy:

```sql
CREATE POLICY "Academy managers can view trainer profiles in their academy"
  ON public.trainer_profiles FOR SELECT
  USING (
    id IN (
      SELECT at.trainer_profile_id
      FROM academy_trainers at
      WHERE at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );
```

---

## Result After Fix

| Action | Before | After |
|--------|--------|-------|
| Edit experience years | Fails silently | Saves correctly |
| Edit hourly rate | Fails silently | Saves correctly |
| Edit certifications | Fails silently | Saves correctly |
| Edit name/bio/rating | Works (edge function) | Works (unchanged) |

Academy managers will be able to fully edit their trainers' profiles, matching the behavior available to admins and club managers.

