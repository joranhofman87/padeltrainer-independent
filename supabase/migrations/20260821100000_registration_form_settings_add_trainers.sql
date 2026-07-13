-- ============================================================================
-- REGISTRATION · add `applicable_trainer_ids` to the FORM-ONLY settings subset
-- ============================================================================
-- WHY: the public registration form resolves its cycle via getRegistration →
-- registrationToCycle (the `registrations` OVERLAY), whose settings are the
-- `_registration_form_settings()` subset. That subset stripped
-- `applicable_trainer_ids`, so the public form never received the admin's chosen
-- trainer set. It is a form-DISPLAY key (which trainers to show / offer), exactly
-- like `show_preferred_trainer` — add it so the public form can show those
-- trainers' profiles (+ the optional preference picker).
--
-- Re-emitted VERBATIM from 20260630130000_registration_write_rpcs.sql with the one
-- key appended. CREATE OR REPLACE (idempotent) — both create/update_registration_
-- with_cycle call this helper, so both pick it up. Kept in lockstep with the
-- Phase-2 backfill (docs/PHASE2_STEP3_CUTOVER.sql) and the golden
-- (src/test/fixtures/settingsSplit.golden.ts). Owner-applied (`supabase db push`).
-- No schema/RETURNS change → no types.ts regeneration.
-- ============================================================================

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
         'applicable_trainer_ids'
       ]) AS k
      WHERE p_settings ? k),
    '{}'::jsonb
  );
$$;
