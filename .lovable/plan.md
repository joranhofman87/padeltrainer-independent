

# Add RLS Recursion Regression Tests

## Problem
RLS infinite recursion bugs have broken the app multiple times. There's no automated check to catch this early.

## Approach
Create an edge function `rls-smoke-test` that performs lightweight queries against the critical tables (profiles, trainer_profiles, bookings, academy_profiles, etc.) using the **anon key** (simulating an authenticated user context). If any query returns a 500/infinite recursion error, the test fails. Then add an E2E test that calls this edge function and asserts all checks pass.

This catches recursion at the database level — where it actually happens — rather than trying to unit-test SQL policies.

## Changes

### 1. New edge function: `supabase/functions/rls-smoke-test/index.ts`
- Accept a service-role call
- For each critical table (`profiles`, `trainer_profiles`, `bookings`, `academy_profiles`, `academy_managers`, `availability_slots`), run a simple `.select('id').limit(1)` query using the **anon client** (to trigger RLS evaluation)
- Return a JSON report: `{ table: string, ok: boolean, error?: string }[]`
- If any table has "infinite recursion" in the error, flag it

### 2. New E2E test: `e2e/rls-health.spec.ts`
- Call the `rls-smoke-test` edge function
- Assert all tables return `ok: true`
- Assert no errors contain "infinite recursion"
- This runs in CI on every push, catching regressions before deploy

### 3. Extend existing health-check function
- Add an RLS smoke check to the existing `health-check` edge function as an additional check (queries `profiles` and `trainer_profiles` with anon key)
- This provides ongoing monitoring beyond just CI

| File | Change |
|------|--------|
| `supabase/functions/rls-smoke-test/index.ts` | New edge function that tests RLS on critical tables |
| `e2e/rls-health.spec.ts` | New E2E test calling the smoke-test function |
| `supabase/functions/health-check/index.ts` | Add RLS recursion check to existing health endpoint |

