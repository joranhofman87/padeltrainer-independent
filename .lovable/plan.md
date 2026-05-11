## What this finding means

`academy_trainers.payment_percentage` stores the confidential revenue split between an academy and a trainer. The `Public can view active academy trainers` RLS policy lets anyone (anon + authenticated, including other academies/trainers) read full rows from this table for any active+public academy, and that includes `payment_percentage`. A simple `select('payment_percentage')` from the public client would expose every active split.

You're right that we don't use the field today: a repo-wide search for `payment_percentage` returns zero hits. So nothing in the app needs it via a public read; only academy managers/admins should ever see it.

## Fix plan

Single migration, no code changes needed.

1. **Column-level lockdown** on `public.academy_trainers`:
   ```sql
   REVOKE SELECT (payment_percentage) ON public.academy_trainers FROM anon, authenticated;
   ```
   Existing policies still allow row reads, but the column itself becomes unreadable to PostgREST clients. Academy managers and admins keep access through the existing `_owner`-style pattern (next step).

2. **Re-grant via owner view** (matches the existing `*_profiles_owner` pattern from the financial isolation work):
   ```sql
   CREATE OR REPLACE VIEW public.academy_trainers_owner
   WITH (security_invoker = false) AS
   SELECT * FROM public.academy_trainers
   WHERE
     academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
     OR trainer_profile_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
     OR is_admin(auth.uid());

   ALTER VIEW public.academy_trainers_owner OWNER TO postgres;
   GRANT SELECT ON public.academy_trainers_owner TO authenticated;
   ```
   Trainers can see their own split; academy managers can see all their trainers' splits; admins see everything; the public can't see the column at all.

3. **Mark the finding fixed** with `manage_security_finding` after the migration runs.

## Files touched

- One new migration file (REVOKE + CREATE VIEW).
- No frontend or edge-function changes — nothing reads `payment_percentage` today, and if/when that feature is built it will go through `academy_trainers_owner`.

## Verification

- After migration, run `select payment_percentage from academy_trainers limit 1` as anon → should fail with permission denied.
- Run the same as an academy manager via `academy_trainers_owner` → should succeed for their own academy rows.

## Out of scope (separate findings already in your scan)

- Realtime channel RLS, weak temp password generation, Supabase linter warnings on SECURITY DEFINER functions / mutable search_path / public bucket listing — these are separate and not addressed by this plan.
