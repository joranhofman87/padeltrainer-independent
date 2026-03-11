
Root cause confirmed from the current backend data and code:

1) “Reset proposals” is not fully resetting for academy owners.
- `intake_requests.status` is set back to `new`, but old rows in `proposed_assignments` remain.
- This happens because academy RLS policies exist for `cycles`/`intake_requests`, but not for `proposed_assignments` management.

2) Proposal generation skips those rows silently.
- In `generate-proposals`, requests with an existing `proposed_assignments` row are skipped (`existingProposalRequestIds`) without assigning a `skip_reason`.
- Since reset leaves stale proposals behind, only truly “proposal-free” rows get regenerated (your “only 1 generated” behavior).

3) Why UI looks broken:
- Rows stay `new` with `skip_reason = null`, so they look untouched.
- Grouped skipped reasons remain empty because no reason was written.

Implementation plan

1. Add missing academy proposal permissions (database migration)
- Add academy manager RLS policies on `proposed_assignments` for SELECT and ALL (or explicit INSERT/UPDATE/DELETE), aligned with existing academy ownership checks.
- This unblocks academy users from properly resetting/managing proposal rows.

2. Data repair migration for existing inconsistent rows
- Remove stale `proposed_assignments` linked to `intake_requests.status = 'new'` (currently present in your cycle).
- This restores consistency immediately so next generation is clean.

3. Harden `resetProposals` in `src/lib/cycles.ts`
- Reset should always:
  - delete all `proposed_assignments` for the cycle first
  - reset applicable intake rows to `status='new'`
  - clear `skip_reason` as part of reset
- Add a defensive post-check (if proposals still exist for the cycle after reset, throw and surface error).

4. Harden `generate-proposals` backend function
- Before assignment loop, defensively delete stale proposals for the “new” request IDs being processed.
- Remove/replace the silent “already has proposal -> skip” path so every non-generated request ends with a meaningful state.
- Ensure early no-slot path writes skip reasons for all impacted requests (not only return `{ skipped }`).

5. Improve generation feedback in intake pages
- In `AcademyIntakeRequests.tsx` and `TrainerIntakeRequests.tsx`, show a result toast including both generated and skipped counts (not just generated).
- If skipped > 0, include hint to open the “Skipped” tab for grouped reasons.

Technical details (implementation-focused)

Files to update:
- `supabase/migrations/<new>.sql`
  - Add academy RLS policies for `proposed_assignments`
  - One-time cleanup delete for stale proposal rows linked to `status='new'`
- `src/lib/cycles.ts`
  - Strengthen `resetProposals` reset logic and verification
- `supabase/functions/generate-proposals/index.ts`
  - Defensive cleanup + guaranteed skip reason assignment paths
- `src/pages/academy/AcademyIntakeRequests.tsx`
- `src/pages/TrainerIntakeRequests.tsx`
  - improved generated/skipped toast messaging

Validation plan

1) For cycle `09b9d410-a77f-45ba-9cae-2c76b0928d34`:
- Run Reset proposals.
- Verify there are zero `proposed_assignments` for this cycle afterward.
- Verify all visible rows are `new` and `skip_reason` cleared.

2) Run Generate proposals again:
- Expect all registrations to end as either:
  - `proposed`, or
  - `new` with `skip_reason` populated.
- “Skipped” tab must appear when skipped > 0.
- Grouped skip reason banner should show counts.

3) Regression:
- Confirm trainer/club flows still reset/generate normally.
- Confirm no duplicate/stale proposal rows remain after multiple reset/generate cycles.
