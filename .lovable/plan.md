

## Fix: Trainers Not Loading in Generate Proposals Wizard

### Root Cause
The query uses a PostgREST join: `profiles:user_id (full_name)` on `trainer_profiles`. However, there are **no foreign keys** between `trainer_profiles` and `profiles` tables, so PostgREST cannot resolve this join. The query either errors silently or returns empty data, resulting in no trainers appearing.

### Fix

**File: `src/components/cycles/GenerateProposalsWizard.tsx`** — `loadTrainers` function

Split the nested join into two sequential queries:

1. Query `trainer_profiles` for `id, user_id, preferred_min_rating, preferred_max_rating`
2. Query `profiles` separately using the collected `user_id` values to get `full_name`
3. Merge them in JS

Same fix applies to both the `academy` branch and the `trainer` branch of `loadTrainers`.

~15 lines changed total. No new files, no DB changes needed.

