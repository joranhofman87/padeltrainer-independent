-- ===========================================================================
-- academy_fixture.sql — DISPOSABLE-CLONE ONLY. Builds a production-shaped graph
-- and asserts get_academy_undeliverable_recipients() honours every billing/
-- linked-profile precedence rule, then ROLLS BACK so nothing persists. The
-- rollback is proven after the fact (the sentinel academy slug must be absent).
--
-- Runs inside a single transaction that is ALWAYS rolled back. Requires the
-- prod-shaped auth.users / auth.uid() / is_academy_manager to exist (they do on
-- a Supabase clone; the local verify harness provides faithful stubs).
--
-- Deterministic UUIDs so assertions can name exact expected keys/emails.
-- Precedence cases exercised:
--   1. registered: billing_email override wins over profiles.email
--   2. guest:      billing_email override wins over guest.email
--   3. guest:      linked-profile email wins over guest.email (no billing override)
--   4. provider-only suppression (state='ok' + provider_suppressed_active) -> 'provider_suppressed'
--   5. NEGATIVE control: a non-suppressed player must NOT appear
-- ===========================================================================
\ir _assert.sql

BEGIN;

-- act as the academy manager for the SECURITY DEFINER reader's auth.uid() gate.
-- Set both claim forms so this works whichever auth.uid() variant the target uses.
SELECT set_config('request.jwt.claims',      '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub',   '11111111-1111-1111-1111-111111111111', true);

-- ---- identities (auth.users first: profiles.user_id FK) --------------------
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- manager (also academy_managers.user_id, no FK there)
  ('21111111-1111-1111-1111-111111111111'),   -- registered override player login
  ('41111111-1111-1111-1111-111111111111'),   -- linked-profile login (guest linked case)
  ('24111111-1111-1111-1111-111111111111'),   -- provider-suppressed player login
  ('25111111-1111-1111-1111-111111111111');   -- negative-control player login

-- ---- academy + manager linkage --------------------------------------------
INSERT INTO public.academy_profiles (id, name, slug) VALUES
  ('aca00000-0000-0000-0000-000000000001', 'Rollout Fixture Academy', 'rollout-fixture-academy-sentinel');
INSERT INTO public.academy_managers (academy_profile_id, user_id) VALUES
  ('aca00000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111');

-- ---- profiles (registered player, linked profile, provider, negative) -----
INSERT INTO public.profiles (id, user_id, full_name, email) VALUES
  ('20000000-0000-0000-0000-000000000001', '21111111-1111-1111-1111-111111111111', 'Reg Override',   'reg-clean@example.test'),
  ('40000000-0000-0000-0000-000000000003', '41111111-1111-1111-1111-111111111111', 'Linked Profile', 'linked-bounced@example.test'),
  ('20000000-0000-0000-0000-000000000004', '24111111-1111-1111-1111-111111111111', 'Reg Provider',   'reg-provider@example.test'),
  ('20000000-0000-0000-0000-000000000005', '25111111-1111-1111-1111-111111111111', 'Reg Ok',         'reg-ok@example.test');

-- ---- guests (academy-scoped; trainer_id NULL) -----------------------------
INSERT INTO public.guest_players (id, academy_profile_id, trainer_id, full_name, email, phone, linked_profile_id) VALUES
  ('30000000-0000-0000-0000-000000000002', 'aca00000-0000-0000-0000-000000000001', NULL, 'Guest Override', 'guest-clean@example.test', 'x', NULL),
  ('30000000-0000-0000-0000-000000000003', 'aca00000-0000-0000-0000-000000000001', NULL, 'Guest Linked',   'guest-raw@example.test',   'x', '40000000-0000-0000-0000-000000000003');

-- ---- academy_player_metadata (billing overrides; academy-scoped) ----------
-- registered override: billing_email must win over profiles.email
INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, billing_email) VALUES
  ('aca00000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'reg-bounced@example.test');
-- provider-suppressed registered: no billing override -> effective = profiles.email
INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, billing_email) VALUES
  ('aca00000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', NULL);
-- negative control registered: no override, effective email is deliverable
INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, billing_email) VALUES
  ('aca00000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', NULL);
-- guest override: billing_email must win over guest.email
INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, billing_email) VALUES
  ('aca00000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'guest-bounced@example.test');
-- guest linked: no billing override -> linked-profile email must win over guest.email
INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, billing_email) VALUES
  ('aca00000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', NULL);

-- ---- suppression state keyed on the EFFECTIVE (lowercased) address ---------
-- suppressed addresses (must appear):
INSERT INTO public.email_address_state (email, state, provider_suppressed_active, last_event_at) VALUES
  ('reg-bounced@example.test',    'hard_bounced', false, '2026-07-01T00:00:00Z'),   -- case 1
  ('guest-bounced@example.test',  'hard_bounced', false, '2026-07-01T00:00:00Z'),   -- case 2
  ('linked-bounced@example.test', 'complained',   false, '2026-07-01T00:00:00Z'),   -- case 3
  ('reg-provider@example.test',   'ok',           true,  '2026-07-01T00:00:00Z');    -- case 4 provider-only
-- NON-suppressed addresses that WOULD appear if precedence were wrong (must NOT):
INSERT INTO public.email_address_state (email, state, provider_suppressed_active) VALUES
  ('reg-clean@example.test',   'hard_bounced', false),   -- registered login email; override must hide it
  ('guest-clean@example.test', 'hard_bounced', false),   -- guest raw email; billing override must hide it
  ('guest-raw@example.test',   'hard_bounced', false);   -- guest raw email; linked email must hide it
-- reg-ok@example.test intentionally has NO suppressed row (negative control stays absent).

-- ---- run the reader as the manager ----------------------------------------
CREATE TEMP TABLE fixture_result ON COMMIT DROP AS
  SELECT * FROM public.get_academy_undeliverable_recipients('aca00000-0000-0000-0000-000000000001');

-- ---- assertions -----------------------------------------------------------
-- case 1: registered billing override wins (reg-bounced, not reg-clean)
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM fixture_result
  WHERE player_key='p_20000000-0000-0000-0000-000000000001' AND player_type='registered'
    AND email='reg-bounced@example.test' AND state='hard_bounced'
    AND profile_id='20000000-0000-0000-0000-000000000001' AND guest_player_id IS NULL),
  'case1 registered billing_email override wins over profiles.email');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM fixture_result WHERE email='reg-clean@example.test'),
  'case1 registered login email is NOT used when an override exists');

-- case 2: guest billing override wins (guest-bounced, not guest-clean)
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM fixture_result
  WHERE player_key='g_30000000-0000-0000-0000-000000000002' AND player_type='guest'
    AND email='guest-bounced@example.test' AND state='hard_bounced'
    AND guest_player_id='30000000-0000-0000-0000-000000000002'),
  'case2 guest billing_email override wins over guest.email');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM fixture_result WHERE email='guest-clean@example.test'),
  'case2 guest raw email is NOT used when an override exists');

-- case 3: linked-profile email wins over guest raw email (no billing override)
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM fixture_result
  WHERE player_key='g_30000000-0000-0000-0000-000000000003' AND player_type='guest'
    AND email='linked-bounced@example.test' AND state='complained'
    AND guest_player_id='30000000-0000-0000-0000-000000000003'
    AND profile_id='40000000-0000-0000-0000-000000000003'),
  'case3 linked-profile email wins over guest.email (linked-profile-over-guest)');
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM fixture_result WHERE email='guest-raw@example.test'),
  'case3 guest raw email is NOT used when a linked profile has an address');

-- case 4: provider-only suppression yields the synthesized 'provider_suppressed' state
SELECT pg_temp.assert(EXISTS (
  SELECT 1 FROM fixture_result
  WHERE player_key='p_20000000-0000-0000-0000-000000000004'
    AND email='reg-provider@example.test' AND state='provider_suppressed'),
  'case4 provider-only suppression maps to state=provider_suppressed');

-- case 5: negative control — deliverable player must NOT appear
SELECT pg_temp.assert(NOT EXISTS (
  SELECT 1 FROM fixture_result WHERE player_key='p_20000000-0000-0000-0000-000000000005'),
  'case5 a non-suppressed player is excluded');

-- exact-cardinality guard: precisely the four suppressed players
SELECT pg_temp.assert_eq((SELECT count(*) FROM fixture_result)::bigint, 4::bigint,
  'reader returns exactly the four suppressed players');

ROLLBACK;

-- ---- prove the fixture left nothing behind --------------------------------
-- Raw DO block (no pg_temp): when the whole file runs as one implicit
-- transaction the ROLLBACK discards the pg_temp helpers too, so assert directly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.academy_profiles WHERE slug='rollout-fixture-academy-sentinel') THEN
    RAISE EXCEPTION 'ASSERT FAILED: fixture academy persisted after ROLLBACK';
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_address_state WHERE email='reg-bounced@example.test') THEN
    RAISE EXCEPTION 'ASSERT FAILED: fixture suppression rows persisted after ROLLBACK';
  END IF;
  RAISE NOTICE 'ok: ROLLBACK proven — fixture academy + suppression rows absent';
  RAISE NOTICE 'note: academy_fixture: all precedence assertions passed; rollback clean';
END $$;
