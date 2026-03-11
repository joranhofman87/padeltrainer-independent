

## Fix: Broken Proposal Data Fetching

The proposals are being generated correctly in the database, but **the UI still can't display them** because the broken PostgREST join was never actually fixed in the previous round. The root cause is the same one identified before:

```
profiles!trainer_profiles_user_id_fkey(full_name, avatar_url)
```

This FK points to `auth.users`, not `profiles`, so PostgREST silently returns `null` for trainer info. This causes:
- Schedule grid: shows "No proposals" (because `proposal.trainer` is null, the merge logic fails)
- Detail sheet: shows "No proposal generated" (same reason)

### Fix (2 functions in `src/lib/cycles.ts`)

**1. `getIntakeRequestsWithProposals` (line ~497-507)**
Split into two queries:
- Fetch `proposed_assignments` with `slot:availability_slots(...)` only (remove the nested trainer→profiles join)
- For each unique `trainer_id`, fetch the `trainer_profiles.user_id`, then batch-fetch `profiles` by those `user_id`s to get `full_name` and `avatar_url`

**2. `getProposedAssignmentForRequest` (line ~786-800)**
Same fix — remove the nested profiles join, resolve trainer name via a separate query on `profiles` using the trainer's `user_id`.

**3. `ProposalCard.tsx` (line 108-111)**
Update the trainer name/avatar extraction to use the new flat structure instead of the broken nested `proposal.trainer?.profile` path.

### Files to edit
- `src/lib/cycles.ts` — fix both query functions
- `src/components/cycles/ProposalCard.tsx` — update trainer data access pattern

No database changes needed. No new components needed.

