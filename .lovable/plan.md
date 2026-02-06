

# Fix: Trainers Page Empty When Logged In as Player

## Root Cause

The `Trainers` page queries two views:
1. `trainer_profiles_safe` -- works fine (has a policy allowing anyone to read rows where `is_public = true`)
2. `profiles_public` -- **fails for logged-in players**

The `profiles_public` view uses `security_invoker=on`, meaning it runs queries as the calling user. The underlying `profiles` table only has these SELECT policies:
- Admins can view all profiles
- Users can view their own profile

A logged-in player can only see their **own** profile row. Since none of the trainer user IDs match the player's ID, all profile lookups return empty. The trainers load but have `profile: null`, and the page shows a loading state or empty results.

When visiting anonymously (not logged in), the `anon` role also hits the same policies -- but "Users can view own profile" with `auth.uid() = user_id` returns false for all rows when there's no session. However, the `trainer_profiles_safe` query still returns trainer data, and `profiles_public` also returns nothing for anon. **The reason it works on the marketing site without login is likely because the profiles data happens to not be strictly required for rendering.**

Actually, looking more carefully: anonymous users also can't read profiles. The difference is likely that when not logged in, the page still renders trainer cards (just without profile data like names), but when logged in as a player, something in the auth loading flow causes the page to get stuck.

## Solution

Add an RLS policy on the `profiles` table that allows anyone to read the **non-sensitive columns** exposed by the `profiles_public` view. Since `profiles_public` already excludes sensitive fields like `email`, we just need a SELECT policy allowing public read access.

### Database Migration

```sql
-- Allow anyone to read profiles (the profiles_public view already limits visible columns)
CREATE POLICY "Anyone can view profiles via public view"
  ON public.profiles
  FOR SELECT
  TO public
  USING (true);
```

**Wait** -- this would expose `phone` which is in the `profiles_public` view. Let me reconsider.

The safer approach: update the `profiles_public` view to exclude `phone`, then add the public read policy on the base table. But since the view has `security_invoker=on`, the policy controls access, not the view columns.

Better approach: Create a **more restrictive policy** that only allows reading profiles that belong to public trainers:

```sql
CREATE POLICY "Anyone can view trainer profiles publicly"
  ON public.profiles
  FOR SELECT
  TO public
  USING (
    user_id IN (
      SELECT user_id FROM public.trainer_profiles WHERE is_public = true
    )
  );
```

This way only profiles of public trainers are readable, not all user profiles.

### Also: Remove `phone` from `profiles_public` view

The `profiles_public` view currently includes `phone`, which is PII. Since this view will now be publicly readable, we should drop and recreate it without `phone`.

### Summary of Changes

1. **Database migration**: 
   - Recreate `profiles_public` view **without** the `phone` column
   - Add RLS policy on `profiles` allowing public SELECT for users who are public trainers

2. **No code changes needed** -- the `Trainers.tsx` page already queries the right views, it just needs the data to be accessible.
