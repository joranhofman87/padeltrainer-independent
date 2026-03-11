

## Fix AddIntakeRequestDialog Crash

### Root Cause Analysis

The screenshot shows two errors:
1. **Supabase schema cache error**: `"Could not find a relationship between 'trainer_profiles' and 'profiles'"` — caused by the `profiles:user_id (full_name)` join syntax on line 193 of `AddIntakeRequestDialog.tsx`. PostgREST can't resolve this join because there's no direct FK from `trainer_profiles` to `profiles` (both reference `auth.users` independently).
2. **React error #185** (Objects not valid as React child) — the unhandled Supabase error cascades into a rendering crash.

Additionally, the `fetchTrainers` effect is **missing an `academy` branch** entirely — academy-owned cycles don't load their trainers.

### Changes

**`src/components/cycles/AddIntakeRequestDialog.tsx`**:

1. **Fix the broken trainer-type join** (lines 193-206): Replace the `profiles:user_id (full_name)` PostgREST join with two separate queries (fetch trainer profile, then fetch profile name), matching the pattern already used in the `club` branch.

2. **Add `academy` branch to `fetchTrainers`** (after line 207): For academy-owned cycles, query `academy_trainers` → `trainer_profiles` → `profiles` to populate the trainers dropdown, using the same two-step query pattern.

3. **Wrap `fetchTrainers` in try-catch**: The entire async function currently has no error handling. Add a try-catch so Supabase query failures don't become unhandled promise rejections that crash React.

### Files to Edit
- `src/components/cycles/AddIntakeRequestDialog.tsx`

