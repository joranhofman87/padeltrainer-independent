
# Fix: Infinite Recursion in trainer_profiles RLS Policy

## Root Cause

The SELECT policy I added earlier is causing infinite recursion:

```sql
-- PROBLEMATIC POLICY
CREATE POLICY "Academy managers can view trainer profiles in their academy"
  ON public.trainer_profiles FOR SELECT
  USING (
    id IN (
      SELECT at.trainer_profile_id
      FROM academy_trainers at  -- This query triggers the policy again!
      WHERE at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );
```

When PostgREST executes a join from `academy_trainers` to `trainer_profiles`:
1. It evaluates the SELECT policy on `trainer_profiles`
2. That policy queries `academy_trainers`
3. Which has a join back to `trainer_profiles`
4. Which triggers the SELECT policy again (infinite loop)

## Solution

Create a **SECURITY DEFINER** function that checks if a trainer belongs to any of the user's academies. This function bypasses RLS internally and prevents the recursion.

### Database Changes

**1. Create a new helper function:**

```sql
CREATE OR REPLACE FUNCTION public.is_academy_trainer(_user_id uuid, _trainer_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM academy_trainers at
    WHERE at.trainer_profile_id = _trainer_profile_id
      AND at.academy_profile_id IN (
        SELECT academy_profile_id 
        FROM academy_managers 
        WHERE user_id = _user_id
      )
  )
$$;
```

**2. Drop and recreate the problematic policies:**

```sql
-- Drop the problematic policies
DROP POLICY IF EXISTS "Academy managers can view trainer profiles in their academy" 
  ON public.trainer_profiles;
DROP POLICY IF EXISTS "Academy managers can update trainer profiles in their academy" 
  ON public.trainer_profiles;

-- Recreate SELECT policy using the safe function
CREATE POLICY "Academy managers can view trainer profiles in their academy"
  ON public.trainer_profiles FOR SELECT
  USING (public.is_academy_trainer(auth.uid(), id));

-- Recreate UPDATE policy using the safe function (with active status check)
CREATE POLICY "Academy managers can update trainer profiles in their academy"
  ON public.trainer_profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM academy_trainers at
      WHERE at.trainer_profile_id = id
        AND at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );
```

Wait - the UPDATE policy also has the same recursion risk. We need to use a SECURITY DEFINER function for both.

### Final Solution

**Helper function for checking active academy trainer status:**

```sql
CREATE OR REPLACE FUNCTION public.is_active_academy_trainer(_user_id uuid, _trainer_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM academy_trainers at
    WHERE at.trainer_profile_id = _trainer_profile_id
      AND at.status = 'active'
      AND at.academy_profile_id IN (
        SELECT academy_profile_id 
        FROM academy_managers 
        WHERE user_id = _user_id
      )
  )
$$;
```

**Recreated policies:**

```sql
-- SELECT: any trainer in manager's academies
CREATE POLICY "Academy managers can view trainer profiles in their academy"
  ON public.trainer_profiles FOR SELECT
  USING (public.is_academy_trainer(auth.uid(), id));

-- UPDATE: only active trainers in manager's academies  
CREATE POLICY "Academy managers can update trainer profiles in their academy"
  ON public.trainer_profiles FOR UPDATE
  USING (public.is_active_academy_trainer(auth.uid(), id));
```

---

## Result After Fix

| Scenario | Before | After |
|----------|--------|-------|
| Admin views academy trainers | Works | Works |
| Academy manager views own trainers | 500 Error (recursion) | Works |
| Academy manager edits trainer | Silently fails | Works |
| Admin panel "Add Trainer" dropdown | 500 Error | Works for admins |

---

## Technical Details

The recursion happens because PostgreSQL RLS policies are evaluated during query execution. When a policy contains a subquery that references tables which themselves reference the policy's table, it creates a cycle.

Using `SECURITY DEFINER` functions bypasses RLS for the internal query, breaking the cycle. This is the same pattern used throughout the codebase for `is_admin()`, `is_club_manager()`, `get_user_academy_ids()`, etc.
