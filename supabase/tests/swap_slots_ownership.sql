-- Regression test for P1-2: swap_slots cross-tenant ownership guard.
-- Run: psql "$DATABASE_URL" -f supabase/tests/swap_slots_ownership.sql
-- Rolls back; leaves no persistent data. Requires the migrated schema (auth.uid,
-- trainer_profiles, availability_slots, is_admin, get_user_academy_ids, get_user_club_ids).

BEGIN;

DO $$
DECLARE
  v_owner_user    uuid := gen_random_uuid();
  v_attacker_user uuid := gen_random_uuid();
  v_owner_trainer uuid;
  v_slot_a uuid := gen_random_uuid();
  v_slot_b uuid := gen_random_uuid();
  v_a_start timestamptz := '2030-01-01 10:00+00';
  v_a_end   timestamptz := '2030-01-01 11:00+00';
  v_b_start timestamptz := '2030-01-02 10:00+00';
  v_b_end   timestamptz := '2030-01-02 11:00+00';
  v_got_start_a timestamptz;
  v_raised boolean;
BEGIN
  -- Minimal auth users + owning trainer profile.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  VALUES
    (v_owner_user,   'swap-owner@example.com',    crypt('test', gen_salt('bf')), now(), now(), now()),
    (v_attacker_user,'swap-attacker@example.com', crypt('test', gen_salt('bf')), now(), now(), now());

  -- trainer_profiles.user_id is the only NOT NULL column without a default and is UNIQUE.
  INSERT INTO public.trainer_profiles (user_id)
  VALUES (v_owner_user)
  RETURNING id INTO v_owner_trainer;

  -- Two slots owned by the owner's trainer profile.
  INSERT INTO public.availability_slots (id, trainer_id, start_time, end_time, max_participants, is_public, is_recurring)
  VALUES
    (v_slot_a, v_owner_trainer, v_a_start, v_a_end, 4, false, false),
    (v_slot_b, v_owner_trainer, v_b_start, v_b_end, 4, false, false);

  -- (1) Attacker (no relationship to either slot) must be REJECTED.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_attacker_user::text)::text, true);
  v_raised := false;
  BEGIN
    PERFORM public.swap_slots(
      v_slot_a, v_owner_trainer, v_b_start, v_b_end,
      v_slot_b, v_owner_trainer, v_a_start, v_a_end
    );
  EXCEPTION WHEN others THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL: attacker was allowed to swap slots (cross-tenant guard missing)';
  END IF;

  -- Slot A must be UNCHANGED after the rejected attempt.
  SELECT start_time INTO v_got_start_a FROM public.availability_slots WHERE id = v_slot_a;
  IF v_got_start_a <> v_a_start THEN
    RAISE EXCEPTION 'FAIL: rejected swap still mutated slot A (start=%)', v_got_start_a;
  END IF;

  -- (2) Owning trainer must SUCCEED and the swap must apply.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_user::text)::text, true);
  PERFORM public.swap_slots(
    v_slot_a, v_owner_trainer, v_b_start, v_b_end,
    v_slot_b, v_owner_trainer, v_a_start, v_a_end
  );
  SELECT start_time INTO v_got_start_a FROM public.availability_slots WHERE id = v_slot_a;
  IF v_got_start_a <> v_b_start THEN
    RAISE EXCEPTION 'FAIL: owner swap did not apply (slot A start=%)', v_got_start_a;
  END IF;

  RAISE NOTICE 'PASS: swap_slots ownership guard rejects attacker and allows owner';
END $$;

ROLLBACK;
