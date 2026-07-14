-- ============================================================================
-- Registration forms: persist per-form terms + planning match-criteria
-- ============================================================================
-- Post-decouple a registration is standalone, but three editor fields had nowhere to land:
--   * `terms` (the per-form "Voorwaarden"/Lesreglement shown to applicants) — the shell column it
--     used to write to is gone. Give registrations their own `terms` column + persist it.
--   * min/max group_size and min/max skill_rating (planning match-criteria) — the settings whitelist
--     dropped them. Add them so they save (used later by the planning surface).

-- 1. Per-form terms column.
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS terms text;

-- 2. Extend the form-settings whitelist with the match-criteria keys. Re-emitted from
--    20260821100000 with four keys appended. Both write RPCs call this, so both pick it up.
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
         'notify_admin_on_submission','notify_admin_emails','pricing_note',
         'applicable_trainer_ids',
         'min_group_size','max_group_size','min_skill_rating','max_skill_rating'
       ]) AS k
      WHERE p_settings ? k),
    '{}'::jsonb
  );
$$;

-- 3. Recreate the write RPCs with a p_terms parameter (adding an arg = a new overload, so drop the
--    old signatures first to keep exactly one).
DROP FUNCTION IF EXISTS public.create_registration(text, uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb);
DROP FUNCTION IF EXISTS public.update_registration(uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb);

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
  p_settings            jsonb,
  p_terms               text
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
    enrollment_deadline, status, total_price, currency, price_table, location_id, settings, terms
  ) VALUES (
    p_owner_type, p_owner_id, p_format, p_name, p_description, p_start_date, p_end_date,
    p_enrollment_deadline, COALESCE(p_status, 'draft'), p_total_price,
    COALESCE(p_currency, 'EUR'), p_price_table, p_location_id,
    public._registration_form_settings(COALESCE(p_settings, '{}'::jsonb)), p_terms
  )
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

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
  p_settings            jsonb,
  p_terms               text
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
    terms               = p_terms,
    updated_at          = now()
  WHERE id = p_registration_id
  RETURNING * INTO v_reg;

  RETURN v_reg;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_registration(text, uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_registration(uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text) TO authenticated;
