

# Fix "Unknown" Trainer Names in Generate Proposals Wizard

## Root Cause

The `profiles` table has restrictive RLS policies. An academy manager can only read their **own** profile row. When `loadTrainers()` in `GenerateProposalsWizard` queries `profiles` for trainer names via `user_id`, the RLS blocks all rows except the logged-in user's own profile. That's why only "Rene Lindenbergh" (the logged-in user) shows a name — the other 5 return empty and fall back to "Unknown".

## Fix

Add an RLS SELECT policy on `profiles` allowing academy managers to view profiles of their academy's trainers:

```sql
CREATE POLICY "Academy managers can view their trainers profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  user_id IN (
    SELECT tp.user_id
    FROM trainer_profiles tp
    JOIN academy_trainers at ON at.trainer_profile_id = tp.id
    JOIN academy_managers am ON am.academy_profile_id = at.academy_profile_id
    WHERE am.user_id = auth.uid()
      AND at.status = 'active'
  )
);
```

This is a single database migration. No code changes needed — the existing query logic in `GenerateProposalsWizard` is correct; it just can't read the data due to missing RLS permissions.

## Files
- **Database migration only** — one new RLS policy on `profiles` table

