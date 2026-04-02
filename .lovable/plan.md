

# Fix: Allow admins to update KNLTB numbers on profiles

## Problem
The `saveKnltbMutation` updates `profiles.rating_member_id` via the Supabase client, but there is no RLS policy allowing admins to update the `profiles` table. The existing update policies only allow users to update their own profile or club managers to update their trainers' profiles. The update silently fails due to RLS.

## Solution
Add an RLS policy on `public.profiles` that allows users with the `admin` role to update any profile row. This also fixes the rating save (which updates `profiles.skill_rating`) for non-own profiles.

## Changes

### 1. Database migration — admin update policy on profiles

```sql
CREATE POLICY "Admins can update any profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
```

One migration, no code changes needed — the admin UI code is already correct, it's just blocked by RLS.

