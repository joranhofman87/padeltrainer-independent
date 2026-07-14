-- ============================================================================
-- Registration ↔ cycle decoupling — Phase 2c: standalone registration writes
-- ============================================================================
-- A registration is a FORM, not a cycle. Creating/editing one must write ONLY the
-- registrations table — no cycles shell. These RPCs replace create/update_registration_with_cycle
-- (which minted + synced a type='cyclus' shell, the source of the overlay split-brain). A cycle is
-- created later, at PLANNING time (a separate step). SECURITY DEFINER + explicit owner-auth via the
-- existing _registration_owner_authorized helper (same authz model as the old RPCs).

-- Standalone registrations no longer require a cycle shell.
ALTER TABLE public.registrations ALTER COLUMN source_cycle_id DROP NOT NULL;

-- CREATE — owner-authorized insert into registrations only.
CREATE OR REPLACE FUNCTION public.create_registration(
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
  p_settings            jsonb
)
RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reg public.registrations;
BEGIN
  IF NOT public._registration_owner_authorized(p_owner_type, p_owner_id) THEN
    RAISE EXCEPTION 'not_authorized_for_owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_format NOT IN ('registration', 'event') THEN
    RAISE EXCEPTION 'invalid_format' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.registrations (
    owner_type, owner_id, format, name, description, start_date, end_date,
    enrollment_deadline, status, total_price, currency, price_table, location_id, settings
  ) VALUES (
    p_owner_type, p_owner_id, p_format, p_name, p_description, p_start_date, p_end_date,
    p_enrollment_deadline, COALESCE(p_status, 'draft'), p_total_price,
    COALESCE(p_currency, 'EUR'), p_price_table, p_location_id,
    -- A form only ever holds FORM keys: the editor still assembles cycle-flavoured settings
    -- (allow_single_booking, split_payment, …) — strip them so pure forms carry no engine keys.
    public._registration_form_settings(COALESCE(p_settings, '{}'::jsonb))
  )
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

-- UPDATE — keyed on the registration's OWN id; authorizes against the row's existing owner
-- (never a caller-supplied owner). Cannot change owner/format-to-invalid.
CREATE OR REPLACE FUNCTION public.update_registration(
  p_registration_id     uuid,
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
  p_settings            jsonb
)
RETURNS public.registrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_type text;
  v_owner_id   uuid;
  v_reg        public.registrations;
BEGIN
  SELECT owner_type, owner_id INTO v_owner_type, v_owner_id
    FROM public.registrations WHERE id = p_registration_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'registration_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public._registration_owner_authorized(v_owner_type, v_owner_id) THEN
    RAISE EXCEPTION 'not_authorized_for_owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_format NOT IN ('registration', 'event') THEN
    RAISE EXCEPTION 'invalid_format' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.registrations SET
    format              = p_format,
    name                = p_name,
    description         = p_description,
    start_date          = p_start_date,
    end_date            = p_end_date,
    enrollment_deadline = p_enrollment_deadline,
    status              = COALESCE(p_status, status),
    total_price         = p_total_price,
    currency            = COALESCE(p_currency, currency),
    price_table         = p_price_table,
    location_id         = p_location_id,
    settings            = CASE WHEN p_settings IS NULL THEN settings
                               ELSE public._registration_form_settings(p_settings) END,
    updated_at          = now()
  WHERE id = p_registration_id
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_registration(text, uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_registration(uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb) TO authenticated;
