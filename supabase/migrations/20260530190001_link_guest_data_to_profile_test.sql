-- Phase 1 guest linking: install assertions (no data backfill).
-- Behavioral tests: run supabase/tests/link_guest_data_to_profile.sql on staging.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'link_guest_data_to_profile'
  ) THEN
    RAISE EXCEPTION 'link_guest_data_to_profile function missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'link_guest_invoices_on_signup'
  ) THEN
    RAISE EXCEPTION 'link_guest_invoices_on_signup wrapper missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'link_guest_data_on_guest_player_change'
  ) THEN
    RAISE EXCEPTION 'link_guest_data_on_guest_player_change trigger function missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_profile_created_link_guests'
  ) THEN
    RAISE EXCEPTION 'on_profile_created_link_guests trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_link_guest_data_on_guest_player_change'
  ) THEN
    RAISE EXCEPTION 'trg_link_guest_data_on_guest_player_change trigger missing';
  END IF;

  -- Wrapper must delegate to link_guest_data_to_profile
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'link_guest_invoices_on_signup'
      AND pg_get_functiondef(p.oid) ILIKE '%link_guest_data_to_profile%'
  ) THEN
    RAISE EXCEPTION 'link_guest_invoices_on_signup must call link_guest_data_to_profile';
  END IF;
END $$;
