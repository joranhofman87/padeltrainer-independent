-- Manual / staging verification for link_guest_data_to_profile (Phase 1).
-- Run with: psql $DATABASE_URL -f supabase/tests/link_guest_data_to_profile.sql
-- Uses a transaction rollback so no persistent test data remains.

BEGIN;

DO $$
DECLARE
  v_trainer_user uuid := gen_random_uuid();
  v_player_user uuid := gen_random_uuid();
  v_trainer_profile uuid;
  v_player_profile uuid;
  v_guest uuid;
  v_booking uuid;
  v_invoice uuid;
  v_other_profile uuid;
  v_result jsonb;
  v_player_id uuid;
BEGIN
  -- Minimal auth + profiles (requires service role / migration runner)
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES
    (v_trainer_user, 'link-test-trainer@example.com', crypt('test', gen_salt('bf')), now(), now(), now()),
    (v_player_user, 'link-test-player@example.com', crypt('test', gen_salt('bf')), now(), now(), now());

  SELECT id INTO v_player_profile FROM public.profiles WHERE user_id = v_player_user;
  SELECT id INTO v_trainer_profile FROM public.trainer_profiles LIMIT 1;

  IF v_trainer_profile IS NULL THEN
    RAISE NOTICE 'SKIP: no trainer_profiles row for booking FK';
    RETURN;
  END IF;

  INSERT INTO public.guest_players (trainer_id, full_name, email, phone)
  VALUES (v_trainer_profile, 'Link Test Guest', 'link-test-player@example.com', '')
  RETURNING id INTO v_guest;

  INSERT INTO public.bookings (slot_id, guest_player_id, status)
  SELECT s.id, v_guest, 'confirmed'
  FROM public.availability_slots s
  WHERE s.trainer_id = v_trainer_profile
  LIMIT 1
  RETURNING id INTO v_booking;

  IF v_booking IS NULL THEN
    RAISE NOTICE 'SKIP: no availability slot for test booking';
    RETURN;
  END IF;

  INSERT INTO public.invoices (
    trainer_id, invoice_number, invoice_date, due_date, player_name,
    guest_player_id, line_items, subtotal, vat_rate, vat_amount, total, status
  )
  VALUES (
    v_trainer_profile, 'LINK-TEST-001', current_date, current_date, 'Link Test Guest',
    v_guest, '[]'::jsonb, 10, 21, 2.1, 12.1, 'sent'
  )
  RETURNING id INTO v_invoice;

  v_result := public.link_guest_data_to_profile(v_player_profile);

  IF coalesce((v_result->>'bookings_linked')::int, 0) < 1 THEN
    RAISE EXCEPTION 'expected booking linked, got %', v_result;
  END IF;
  IF coalesce((v_result->>'invoices_linked')::int, 0) < 1 THEN
    RAISE EXCEPTION 'expected invoice linked, got %', v_result;
  END IF;

  SELECT player_id INTO v_player_id FROM public.bookings WHERE id = v_booking;
  IF v_player_id IS DISTINCT FROM v_player_profile THEN
    RAISE EXCEPTION 'booking player_id not set correctly';
  END IF;

  -- Idempotent second run
  v_result := public.link_guest_data_to_profile(v_player_profile);
  IF coalesce((v_result->>'bookings_linked')::int, 0) <> 0
     OR coalesce((v_result->>'invoices_linked')::int, 0) <> 0 THEN
    RAISE EXCEPTION 'second run should link 0 rows, got %', v_result;
  END IF;

  -- No overwrite: pre-set player_id on another booking row
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (gen_random_uuid(), 'other-player@example.com', 'Other')
  RETURNING id INTO v_other_profile;

  UPDATE public.bookings SET player_id = v_other_profile WHERE id = v_booking;
  v_result := public.link_guest_data_to_profile(v_player_profile);
  SELECT player_id INTO v_player_id FROM public.bookings WHERE id = v_booking;
  IF v_player_id IS DISTINCT FROM v_other_profile THEN
    RAISE EXCEPTION 'must not overwrite existing player_id';
  END IF;

  RAISE NOTICE 'link_guest_data_to_profile manual tests passed';
END $$;

ROLLBACK;
