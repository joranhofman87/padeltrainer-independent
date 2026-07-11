-- ============================================================================
-- update_registration_with_cycle — server-side type guard + settings merge (audit Batch 1, V4)
-- ============================================================================
-- update_registration_with_cycle is SECURITY DEFINER and GRANTed to `authenticated`, so a direct
-- RPC call bypasses the client's edit-routing gate (resolveRegistrationEditTarget, #478). Two P3s:
--
--  1. It adopted ANY owned cycle: owner-authorized + format∈(registration,event) were the only
--     checks, so a direct call could turn a TRAINING cyclus into a registration (mints an overlay +
--     rewrites the shell). Add an overlay-or-legacy-type guard: a valid target either already has a
--     registrations overlay (post-split registration, born type='cyclus') OR is a legacy typed
--     registration/event cycle. A plain training cyclus is refused.
--
--  2. It FULL-REPLACED cycles.settings via `COALESCE(p_settings, settings)`. The cycle is meant to
--     keep the FULL settings (booking flags, rebook run-state, …) while the overlay carries only the
--     FORM subset (_registration_form_settings). A direct call passing just the form settings
--     therefore WIPED the booking flags + rebook state; only a client ternary prevented it. Merge
--     the whitelisted form keys onto the existing settings instead — a direct call can now only touch
--     form keys, never booking/rebook state (rec #3: writers merge whitelisted keys, never replace).
--
-- Everything else is re-emitted verbatim.
-- ============================================================================

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

  -- V4 guard: this RPC edits a REGISTRATION/EVENT form — refuse to ADOPT a training cyclus. A valid
  -- target either already has an overlay (post-split registration, born type='cyclus') OR is a legacy
  -- typed registration/event cycle. Mirrors resolveRegistrationEditTarget (#478) server-side.
  IF NOT EXISTS (SELECT 1 FROM public.registrations WHERE source_cycle_id = p_source_cycle_id)
     AND (SELECT COALESCE(type, 'registration') FROM public.cycles WHERE id = p_source_cycle_id)
         NOT IN ('registration', 'event') THEN
    RAISE EXCEPTION 'not_a_registration_cycle' USING ERRCODE = 'check_violation';
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
    -- V4: MERGE only the whitelisted form keys — never full-replace, which wiped booking flags +
    -- rebook run-state when a direct call passed just the form settings.
    settings            = settings || public._registration_form_settings(COALESCE(p_settings, '{}'::jsonb)),
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

GRANT EXECUTE ON FUNCTION public.update_registration_with_cycle(
  uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text, boolean
) TO authenticated;
