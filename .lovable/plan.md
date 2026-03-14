

# Fix: Missing RLS INSERT Policy for Academy Intake Requests

## Root Cause

The `intake_requests` table has an INSERT policy for **club managers** to create intake requests for club cycles, but there is **no equivalent INSERT policy for academy managers**. The cycle `8c8cdf92-0189-4111-9f84-adca26fbd448` is owned by an academy (`rl-padel-performance`).

**Existing INSERT policies:**
1. "Players can create intake requests" — works for logged-in players inserting their own `player_id`
2. "Club managers can create intake requests for club cycles" — only matches `owner_type = 'club'`

**Missing:** Academy managers inserting intake requests for academy cycles (e.g., manual registration from dashboard, or testing their own form while logged in).

When an academy manager is logged in and either:
- Tests their own registration form (their `player_id` matches, so policy #1 *should* work — but if they use manual registration from the dashboard, the `player_id` is the new player's, not theirs)
- Adds a manual registration via `AddIntakeRequestDialog` → `createManualIntakeRequest` → client-side insert with another player's `player_id` → **no matching policy** → RLS error

## Fix

Add a single database migration with an INSERT policy for academy managers, mirroring the existing club manager policy:

```sql
CREATE POLICY "Academy managers can create intake requests for academy cycles"
ON public.intake_requests
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM cycles c
    JOIN academy_managers am ON am.academy_profile_id = c.owner_id
    WHERE c.id = intake_requests.cycle_id
      AND c.owner_type = 'academy'
      AND am.user_id = auth.uid()
  )
);
```

**No code changes needed** — only this one migration.

## Also: Trainer INSERT policy is missing too

For consistency, trainers creating manual registrations for their own cycles would hit the same issue. Add:

```sql
CREATE POLICY "Trainers can create intake requests for their cycles"
ON public.intake_requests
FOR INSERT
TO authenticated
WITH CHECK (
  cycle_id IN (
    SELECT c.id FROM cycles c
    WHERE c.owner_type = 'trainer'
      AND c.owner_id IN (
        SELECT tp.id FROM trainer_profiles tp WHERE tp.user_id = auth.uid()
      )
  )
);
```

## Files to Change
- **Database migration only** — two new INSERT policies

