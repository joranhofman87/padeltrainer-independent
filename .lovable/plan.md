
# Fix Admin Trainer Subscription Updates Not Saving

## Problem
When an admin changes a trainer's subscription status via the "Edit Trainer" dialog, the change appears to save (success toast shows) but doesn't actually persist to the database.

## Root Cause
**Missing RLS policy**: There is no Row-Level Security (RLS) policy allowing admins to UPDATE records in the `trainer_profiles` table.

Current UPDATE policies on `trainer_profiles`:
- "Trainers can update their own trainer profile" - only allows trainers to update their own record
- "Club managers can update trainer profiles at their locations" - only for club-associated trainers

The admin SELECT policy exists (`Admins can view all trainer profiles`), but no corresponding UPDATE policy.

## Why the Toast Shows Success
The save process has two parts:
1. Edge function call to `update-user` → This succeeds (updates `profiles` table)
2. Direct Supabase update to `trainer_profiles` → Silently affects 0 rows due to RLS

The code doesn't check how many rows were actually affected, so it shows success even when the trainer profile update fails.

## Solution

### Step 1: Add Missing RLS Policy
Create an RLS policy to allow admins to update trainer profiles:

```sql
CREATE POLICY "Admins can update any trainer profile"
ON trainer_profiles FOR UPDATE
USING (is_admin(auth.uid()));
```

### Step 2: (Optional) Add Error Detection
Improve the TrainerEditDialog to verify the update actually worked by checking the response or re-fetching the data.

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| Database migration | Create | Add RLS policy for admin UPDATE on trainer_profiles |

## Technical Notes

1. The `is_admin()` helper function already exists and is used by other admin policies
2. This follows the same pattern as other admin tables (e.g., `club_profiles` has "Admins can update any club profile")
3. No code changes required in `TrainerEditDialog.tsx` - the fix is purely at the database level
