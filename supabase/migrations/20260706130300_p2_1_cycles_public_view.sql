-- P2-1: the anon SELECT policy "Anyone can view open cycles" on public.cycles
-- (USING status='open', no TO clause -> applies to anon) exposes
-- cycles.settings.notify_admin_emails (a private staff email list) to any
-- unauthenticated caller of the public register/:cycleId form and the public
-- open-cycles lists. RLS is row-level and cannot strip a JSONB key, so we follow
-- the repo convention for anon-readable public data (cf. academy_trainers_public /
-- trainer_profiles_safe / profiles_public): a postgres-owned view whose body runs
-- as the view owner and therefore bypasses base-table RLS, exposing the SAME
-- columns the public pages read but with `settings` sanitized to REMOVE the
-- private notify keys. `terms` is intentionally kept (it is the terms &
-- conditions the registrant consents to, rendered on the public form).
--
-- The view exposes PLAIN columns only (NO PostgREST embed): PostgREST cannot
-- auto-detect an embed on a plain view, so the frontend joins `locations` in JS.
--
-- Non-destructive: no data is modified. The WHERE reproduces the EXACT anon
-- predicate (status='open') so the public contract is not widened one row.

DROP VIEW IF EXISTS public.cycles_public;

CREATE VIEW public.cycles_public AS
  SELECT
    c.id,
    c.owner_type,
    c.owner_id,
    c.name,
    c.description,
    c.start_date,
    c.end_date,
    c.enrollment_deadline,
    c.is_always_open,
    -- Strip the private staff-notification keys. Every other settings key
    -- (form config AND the training keys the public booking page reads) is kept.
    -- Do NOT expose notify_admin_emails via this view.
    (c.settings - 'notify_admin_emails' - 'notify_admin_on_submission') AS settings,
    c.status,
    c.type,
    c.location_id,
    c.price_per_session,
    c.total_price,
    c.currency,
    c.terms,
    c.price_table,
    c.created_at,
    c.updated_at
  FROM public.cycles c
  WHERE c.status = 'open';

ALTER VIEW public.cycles_public OWNER TO postgres;

GRANT SELECT ON public.cycles_public TO anon, authenticated;

-- Re-scope the base-table anon read: authenticated non-owner players still need
-- to read open cycles on public pages, but anon must go through the sanitized
-- view. Idempotent.
DROP POLICY IF EXISTS "Anyone can view open cycles" ON public.cycles;
CREATE POLICY "Anyone can view open cycles"
  ON public.cycles FOR SELECT
  TO authenticated
  USING (status = 'open');
