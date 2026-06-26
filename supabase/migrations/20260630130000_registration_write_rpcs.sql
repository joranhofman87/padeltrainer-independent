-- ============================================================================
-- PHASE 4 · SLICE 1 — canonical registration WRITE path (ADDITIVE, INERT)
-- ============================================================================
--
-- Two SECURITY DEFINER RPCs that create / edit a registration FORM atomically
-- together with its training-cycle shell. They mirror EXACTLY the column +
-- settings split that the Phase-2 backfill (docs/PHASE2_STEP3_CUTOVER.sql)
-- defines, so a form created here is indistinguishable from a legacy cycle that
-- was later backfilled:
--   * the `registrations` row = the FORM overlay (form fields + price + the
--     FORM-ONLY settings subset),
--   * the `cycles` row = the TRAINING container, born type='cyclus', keeping the
--     FULL settings (non-destructive, identical to the backfill end-state).
--
-- INERT: no client calls these yet (the lib + editor adopt them in later slices).
-- Atomic: each RPC is one transaction → no orphan cycle on a half-failure.
-- Owner-applied (migrations are not auto-deployed).
-- ============================================================================

-- The FORM-ONLY settings keys. The registration carries this subset; the cycle
-- keeps the full settings. This array is the SAME list the backfill uses
-- (docs/PHASE2_STEP3_CUTOVER.sql) — keep them in lockstep.
CREATE OR REPLACE FUNCTION public._registration_form_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    (SELECT jsonb_object_agg(k, p_settings->k)
       FROM unnest(ARRAY[
         'lesson_types','custom_lesson_types','show_preferred_trainer','show_price_indication',
         'cyclus_options','duration_options','available_duration_minutes','price_columns',
         'prices_include_vat','success_message','confirmation_email_text','payment_methods',
         'rating_system','default_duration_minutes','available_days','max_participants',
         'notify_admin_on_submission','notify_admin_emails','pricing_note'
       ]) AS k
      WHERE p_settings ? k),
    '{}'::jsonb
  );
$$;

-- Owner-authorization check mirroring the registrations / cycles RLS predicates.
-- SECURITY DEFINER so it can read the owning-profile tables; never trusts caller
-- input beyond (owner_type, owner_id).
CREATE OR REPLACE FUNCTION public._registration_owner_authorized(p_owner_type text, p_owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (p_owner_type = 'trainer'
       AND p_owner_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()))
    OR (p_owner_type = 'academy'
       AND p_owner_id IN (SELECT public.get_user_academy_ids(auth.uid())))
    OR (p_owner_type = 'club'
       AND p_owner_id IN (SELECT public.get_user_club_ids(auth.uid())));
$$;

-- ----------------------------------------------------------------------------
-- create_registration_with_cycle — NEW form: insert the cyclus shell + the
-- registration overlay (source_cycle_id → shell) in one txn. Returns the row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_registration_with_cycle(
  p_owner_type          text,
  p_owner_id            uuid,
  p_format              text,
  p_name                text,
  p_description         text,
  p_start_date          date,
  p_end_date            date,
  p_enrollment_deadline timestamptz,
  p_status              text,
  p_total_price         numeric,
  p_currency            text,
  p_price_table         jsonb,
  p_location_id         uuid,
  p_settings            jsonb,
  p_terms               text,
  p_is_always_open      boolean
)
RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cycle_id uuid;
  v_reg public.registrations;
BEGIN
  IF NOT public._registration_owner_authorized(p_owner_type, p_owner_id) THEN
    RAISE EXCEPTION 'not_authorized_for_owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_format NOT IN ('registration', 'event') THEN
    RAISE EXCEPTION 'invalid_format' USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Training-container shell, born type='cyclus'. Keeps FULL settings
  --    (non-destructive; matches the backfill). Slot pricing is set later when
  --    slots are added — form pricing lives on the registration.
  INSERT INTO public.cycles (
    owner_type, owner_id, name, description, start_date, end_date,
    enrollment_deadline, is_always_open, status, type, location_id,
    currency, terms, settings
  ) VALUES (
    p_owner_type, p_owner_id, p_name, p_description, p_start_date, p_end_date,
    p_enrollment_deadline, COALESCE(p_is_always_open, false), COALESCE(p_status, 'draft'),
    'cyclus', p_location_id, COALESCE(p_currency, 'EUR'), p_terms,
    COALESCE(p_settings, '{}'::jsonb)
  )
  RETURNING id INTO v_cycle_id;

  -- 2. The FORM overlay — carries the FORM-ONLY settings subset.
  INSERT INTO public.registrations (
    source_cycle_id, owner_type, owner_id, format, name, description,
    start_date, end_date, enrollment_deadline, status, total_price, currency,
    price_table, location_id, settings
  ) VALUES (
    v_cycle_id, p_owner_type, p_owner_id, p_format, p_name, p_description,
    p_start_date, p_end_date, p_enrollment_deadline, COALESCE(p_status, 'draft'),
    p_total_price, COALESCE(p_currency, 'EUR'), p_price_table, p_location_id,
    public._registration_form_settings(COALESCE(p_settings, '{}'::jsonb))
  )
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

-- ----------------------------------------------------------------------------
-- update_registration_with_cycle — EDIT: update the source cycle's shared
-- fields + UPSERT the registration overlay. ON CONFLICT (source_cycle_id) makes
-- it order-independent vs the backfill: editing a legacy not-yet-backfilled
-- cycle ADOPTS it (creates its registration row); editing an already-split one
-- updates in place. Authorizes against the EXISTING cycle's owner.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_registration_with_cycle(
  p_source_cycle_id     uuid,
  p_format              text,
  p_name                text,
  p_description         text,
  p_start_date          date,
  p_end_date            date,
  p_enrollment_deadline timestamptz,
  p_status              text,
  p_total_price         numeric,
  p_currency            text,
  p_price_table         jsonb,
  p_location_id         uuid,
  p_settings            jsonb,
  p_terms               text,
  p_is_always_open      boolean
)
RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_type text;
  v_owner_id uuid;
  v_reg public.registrations;
BEGIN
  SELECT owner_type, owner_id INTO v_owner_type, v_owner_id
    FROM public.cycles WHERE id = p_source_cycle_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'cycle_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public._registration_owner_authorized(v_owner_type, v_owner_id) THEN
    RAISE EXCEPTION 'not_authorized_for_owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_format NOT IN ('registration', 'event') THEN
    RAISE EXCEPTION 'invalid_format' USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Update the training-container's shared fields (mirrors updateCycle).
  UPDATE public.cycles SET
    name                = p_name,
    description         = p_description,
    start_date          = p_start_date,
    end_date            = p_end_date,
    enrollment_deadline = p_enrollment_deadline,
    is_always_open      = COALESCE(p_is_always_open, is_always_open),
    status              = COALESCE(p_status, status),
    location_id         = p_location_id,
    currency            = COALESCE(p_currency, currency),
    terms               = p_terms,
    settings            = COALESCE(p_settings, settings),
    updated_at          = now()
  WHERE id = p_source_cycle_id;

  -- 2. Upsert the registration overlay (ADOPT-on-edit for a legacy cycle).
  INSERT INTO public.registrations (
    source_cycle_id, owner_type, owner_id, format, name, description,
    start_date, end_date, enrollment_deadline, status, total_price, currency,
    price_table, location_id, settings
  ) VALUES (
    p_source_cycle_id, v_owner_type, v_owner_id, p_format, p_name, p_description,
    p_start_date, p_end_date, p_enrollment_deadline, COALESCE(p_status, 'draft'),
    p_total_price, COALESCE(p_currency, 'EUR'), p_price_table, p_location_id,
    public._registration_form_settings(COALESCE(p_settings, '{}'::jsonb))
  )
  ON CONFLICT (source_cycle_id) DO UPDATE SET
    format              = EXCLUDED.format,
    name                = EXCLUDED.name,
    description         = EXCLUDED.description,
    start_date          = EXCLUDED.start_date,
    end_date            = EXCLUDED.end_date,
    enrollment_deadline = EXCLUDED.enrollment_deadline,
    status              = EXCLUDED.status,
    total_price         = EXCLUDED.total_price,
    currency            = EXCLUDED.currency,
    price_table         = EXCLUDED.price_table,
    location_id         = EXCLUDED.location_id,
    settings            = EXCLUDED.settings,
    updated_at          = now()
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_registration_with_cycle(
  text, uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text, boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_registration_with_cycle(
  uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text, boolean
) TO authenticated;
