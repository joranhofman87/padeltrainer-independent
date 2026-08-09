-- U2 — task-specific person-keyed write commands (owner correction, 2026-08-09).
--
-- THE RULE THIS FILE IMPLEMENTS. No browser client, and no generally-authenticated RPC, may
-- receive, select, store or depend on `guest_player_id`. A client that must cause a write into a
-- table that still physically carries the legacy columns hands its canonical `person_id` to ONE of
-- the commands below. The command authorizes the caller, derives the legacy reference INTERNALLY
-- through `person_legacy_source` (which is granted to nobody), completes the write in the same
-- transaction, and answers with canonical ids or a person-keyed projection. The legacy id lives and
-- dies inside the function.
--
-- WHY TASK-SPECIFIC COMMANDS AND NOT A TRANSLATION RPC. The first draft of this correction gave
-- authenticated clients a person→legacy translator (`player_legacy_ref`) and let each caller finish
-- its own write. That moves the leak instead of closing it: the legacy id returned to the browser
-- reappears in state, logs and follow-up requests, and every such caller keeps a live dependency on
-- a table the person-unification plan retires. A command that OWNS its write needs no translator —
-- and when the legacy columns are finally dropped, these commands change their INSERT and their
-- callers change nothing.
--
-- WHAT IS DELIBERATELY NOT HERE. No physical contraction: `guest_players`, `invoices.guest_player_id`,
-- `intake_requests.guest_player_id` and friends keep existing and keep being written — by these
-- commands, server-side. The `stamp_person_id_*` triggers (20260826260000) continue to recompute
-- `person_id` from the legacy columns on write; the commands set all three columns consistently, so
-- the trigger's recomputation is a no-op that double-checks the derivation rather than fighting it.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Invoice creation, keyed on the person
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Replaces the browser-side `.from('invoices').insert({...})` on the three invoice surfaces. The
-- caller supplies WHO the invoice is for as a canonical `person_id` (or NULL for a deliberately
-- unlinked one-time recipient) and the billing text it typed; the legacy `player_id` /
-- `guest_player_id` columns are derived here and only here.
--
-- AUTHORIZATION mirrors the RLS the direct insert ran under, exactly — a definer function that
-- widened it would be a privilege escalation wearing a convenience costume:
--   * trainer scope:  "Trainers can create their own invoices"  (the caller IS that trainer);
--   * academy scope:  "Academy managers can insert custom invoices" (is_academy_manager).
--
-- The PERSON must additionally be one the scope may act on (`player_owner_may_select_person`) —
-- knowing a uuid never grants authorization, so a caller cannot link an invoice to an arbitrary
-- person by guessing their id. A person the scope may act on but with NO legacy source anywhere
-- (cannot normally happen: selectable persons have a profile or an in-scope guest) degrades to an
-- unlinked-but-saved invoice, which is the old resolver's explicit non-blocking contract.
--
-- The unique-number collision (unique_invoice_number_per_trainer/_academy) propagates RAW: the
-- client's allocate-retry loop keys on the constraint name in the error, same as before.
CREATE OR REPLACE FUNCTION public.invoice_create_for_person(
  _owner_type          text,
  _owner_id            uuid,
  _person_id           uuid,
  _invoice_number      text,
  _invoice_date        date,
  _due_date            date,
  _player_name         text,
  _player_business_name text DEFAULT NULL,
  _player_address      text DEFAULT NULL,
  _player_btw_number   text DEFAULT NULL,
  _line_items          jsonb DEFAULT '[]'::jsonb,
  _subtotal            numeric DEFAULT 0,
  _vat_rate            numeric DEFAULT 21,
  _vat_amount          numeric DEFAULT 0,
  _vat_breakdown       jsonb DEFAULT NULL,
  _total               numeric DEFAULT 0,
  _prices_include_vat  boolean DEFAULT false,
  _notes               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile uuid;
  v_guest uuid;
  v_invoice_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'INVOICE_CREATE_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF _owner_type = 'trainer' THEN
    IF NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp
                    WHERE tp.id = _owner_id AND tp.user_id = v_uid) THEN
      RAISE EXCEPTION 'INVOICE_CREATE_FORBIDDEN: you are not that trainer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF _owner_type = 'academy' THEN
    IF NOT public.is_academy_manager(v_uid, _owner_id) THEN
      RAISE EXCEPTION 'INVOICE_CREATE_FORBIDDEN: you do not manage that academy'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'INVOICE_CREATE_BAD_SCOPE: owner_type must be trainer or academy'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF _person_id IS NOT NULL THEN
    IF NOT public.player_owner_may_select_person(_owner_type, _owner_id, _person_id) THEN
      RAISE EXCEPTION 'INVOICE_PERSON_NOT_IN_SCOPE: that Player is not one this % may bill', _owner_type
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT s.profile_id, s.guest_player_id INTO v_profile, v_guest
      FROM public.person_legacy_source(_person_id, _owner_type, _owner_id) s;
  END IF;

  INSERT INTO public.invoices (
    invoice_number, invoice_date, due_date,
    player_name, player_business_name, player_address, player_btw_number,
    person_id, player_id, guest_player_id,
    trainer_id, academy_profile_id,
    line_items, subtotal, vat_rate, vat_amount, vat_breakdown, total,
    status, prices_include_vat, notes
  ) VALUES (
    _invoice_number, _invoice_date, _due_date,
    _player_name, _player_business_name, _player_address, _player_btw_number,
    _person_id, v_profile, v_guest,
    CASE WHEN _owner_type = 'trainer' THEN _owner_id END,
    CASE WHEN _owner_type = 'academy' THEN _owner_id END,
    _line_items, _subtotal, _vat_rate, _vat_amount, _vat_breakdown, _total,
    'draft', _prices_include_vat, _notes
  )
  RETURNING id INTO v_invoice_id;

  RETURN jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_number', _invoice_number,
    'person_id', _person_id);
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_create_for_person(
  text, uuid, uuid, text, date, date, text, text, text, text,
  jsonb, numeric, numeric, numeric, jsonb, numeric, boolean, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_create_for_person(
  text, uuid, uuid, text, date, date, text, text, text, text,
  jsonb, numeric, numeric, numeric, jsonb, numeric, boolean, text)
  TO authenticated;

COMMENT ON FUNCTION public.invoice_create_for_person(
  text, uuid, uuid, text, date, date, text, text, text, text,
  jsonb, numeric, numeric, numeric, jsonb, numeric, boolean, text) IS
  'Creates a draft invoice for a canonical person_id (or NULL for a one-time recipient). Authorization mirrors the invoices INSERT policies exactly; the legacy player_id/guest_player_id columns are derived internally from person_links within the authorized scope and never travel through the client. Returns canonical ids only. Unique-number collisions propagate raw for the caller''s allocate-retry loop.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Manual intake creation, keyed on the person
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Replaces the browser-side `.from('intake_requests').insert({...})` in createManualIntakeRequest
-- (the staff add-a-registration dialog). The dialog first creates/replays the Player through the
-- create-manual-player command and receives ONLY a person_id; this command turns that person into
-- the intake row, deriving the legacy columns internally.
--
-- AUTHORIZATION is the same predicate the direct insert's RLS used: user_owns_registration. The
-- person must also belong to the FORM OWNER's scope — the form owner is who the intake is FOR, and
-- a caller who owns the form cannot attach it to a person some other tenant owns by guessing uuids.
-- CLUB-owned forms are refused by name: guest_players has no club scope (2026-02 constraint), so a
-- club form's manual add has no person to key on — the create step upstream fails first, and this
-- refusal keeps the contract honest rather than silently writing an identity-less row.
CREATE OR REPLACE FUNCTION public.intake_request_create_for_person(
  _registration_id             uuid,
  _person_id                   uuid,
  _full_name                   text,
  _email                       text DEFAULT NULL,
  _phone                       text DEFAULT NULL,
  _rating                      numeric DEFAULT NULL,
  _rating_system               text DEFAULT 'knltb',
  _lesson_types                text[] DEFAULT '{}',
  _preferred_days              text[] DEFAULT '{}',
  _preferred_time_windows      jsonb DEFAULT '[]'::jsonb,
  _preferred_duration_minutes  integer DEFAULT 60,
  _sessions_per_week           integer DEFAULT 1,
  _preferred_trainer_ids       uuid[] DEFAULT '{}',
  _location_id                 uuid DEFAULT NULL,
  _notes                       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_type text;
  v_owner_id uuid;
  v_profile uuid;
  v_guest uuid;
  v_intake_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'INTAKE_CREATE_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.user_owns_registration(_registration_id) THEN
    RAISE EXCEPTION 'INTAKE_CREATE_FORBIDDEN: you do not own that registration form'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _person_id IS NULL THEN
    RAISE EXCEPTION 'INTAKE_PERSON_REQUIRED: a manual intake names the Player it is for'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.owner_type, r.owner_id INTO v_owner_type, v_owner_id
    FROM public.registrations r WHERE r.id = _registration_id;
  IF v_owner_type NOT IN ('trainer', 'academy') THEN
    RAISE EXCEPTION 'INTAKE_PERSON_SCOPE_UNSUPPORTED: a %-owned form has no Player scope to key on', v_owner_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.player_owner_may_select_person(v_owner_type, v_owner_id, _person_id) THEN
    RAISE EXCEPTION 'INTAKE_PERSON_NOT_IN_SCOPE: that Player is not one this form''s owner may register'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.profile_id, s.guest_player_id INTO v_profile, v_guest
    FROM public.person_legacy_source(_person_id, v_owner_type, v_owner_id) s;

  INSERT INTO public.intake_requests (
    registration_id, cycle_id,
    person_id, player_id, guest_player_id,
    full_name, email, phone, rating, rating_system,
    lesson_type, preferred_days, preferred_time_windows,
    preferred_duration_minutes, sessions_per_week, preferred_trainer_ids,
    location_id, notes, consent_given, status
  ) VALUES (
    _registration_id, NULL,
    _person_id, v_profile, v_guest,
    _full_name, nullif(btrim(coalesce(_email, '')), ''), _phone, _rating, coalesce(_rating_system, 'knltb'),
    coalesce(_lesson_types, '{}'), coalesce(_preferred_days, '{}'), coalesce(_preferred_time_windows, '[]'::jsonb),
    coalesce(_preferred_duration_minutes, 60), coalesce(_sessions_per_week, 1), coalesce(_preferred_trainer_ids, '{}'),
    _location_id, _notes, true, 'new'
  )
  RETURNING id INTO v_intake_id;

  RETURN jsonb_build_object(
    'intake_request_id', v_intake_id,
    'person_id', _person_id);
END;
$$;

REVOKE ALL ON FUNCTION public.intake_request_create_for_person(
  uuid, uuid, text, text, text, numeric, text, text[], text[], jsonb, integer, integer, uuid[], uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.intake_request_create_for_person(
  uuid, uuid, text, text, text, numeric, text, text[], text[], jsonb, integer, integer, uuid[], uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.intake_request_create_for_person(
  uuid, uuid, text, text, text, numeric, text, text[], text[], jsonb, integer, integer, uuid[], uuid, text) IS
  'Creates a manual intake_requests row for a canonical person_id. Authorization is user_owns_registration (the same predicate as the RLS the direct insert ran under) plus person-in-scope for the form''s owner; the legacy player_id/guest_player_id columns are derived internally and never travel through the client. Returns canonical ids only.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The person-keyed display projection
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- What the add/import flows render after a create, INSTEAD of re-reading `guest_players` by the id
-- the command used to return. Keyed by person, answers attributes only: there is deliberately no
-- legacy id among the columns, so a caller cannot use the projection as a translator.
--
-- Attributes come from `persons` — the canonical attribute store, rederived across sources — with
-- `notes` from the in-scope guest source (persons carries no notes; an operator note belongs to the
-- operator's scope anyway). A replayed create can answer with a person whose stored attributes
-- differ from what was just typed; showing the STORED truth is the point of reading back at all.
CREATE OR REPLACE FUNCTION public.person_display_for_owner(
  _person_id uuid, _owner_type text, _owner_id uuid
)
RETURNS TABLE (
  person_id uuid,
  full_name text,
  first_name text,
  last_name text,
  email text,
  phone text,
  skill_rating numeric,
  rating_system text,
  notes text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'PERSON_DISPLAY_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.player_owner_may_create(_owner_type, _owner_id, v_uid) THEN
    RAISE EXCEPTION 'PERSON_DISPLAY_FORBIDDEN: you do not control that academy or trainer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.player_owner_may_select_person(_owner_type, _owner_id, _person_id) THEN
    RAISE EXCEPTION 'PERSON_DISPLAY_NOT_IN_SCOPE: that Player is not in this scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.first_name, p.last_name, p.email, p.phone,
         p.skill_rating, p.rating_system,
         (SELECT g.notes FROM public.person_legacy_source(_person_id, _owner_type, _owner_id) s
            JOIN public.guest_players g ON g.id = s.guest_player_id),
         p.created_at
    FROM public.persons p
   WHERE p.id = _person_id;
END;
$$;

REVOKE ALL ON FUNCTION public.person_display_for_owner(uuid, text, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.person_display_for_owner(uuid, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.person_display_for_owner(uuid, text, uuid) IS
  'Person-keyed display projection for the add/import flows: attributes of one person, for an owner authorized to create and act on Players in the scope. Deliberately contains no legacy id — it cannot be used as a person→guest translator. Replaces the client re-read of guest_players by id after a create.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- has_trained, keyed on the person
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The roster twin-mint used to receive a guest id back from the create and immediately UPDATE
-- guest_players.has_trained from the browser. The flag write moves server-side: person in, flag
-- set on whatever in-scope source row carries it today. Returns whether a row was marked, which is
-- false only when the person has no in-scope guest source (registered-only person) — the flag is a
-- guest-list display concern and a registered player's lists do not read it.
CREATE OR REPLACE FUNCTION public.person_mark_has_trained(
  _person_id uuid, _owner_type text, _owner_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_guest uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'HAS_TRAINED_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.player_owner_may_create(_owner_type, _owner_id, v_uid) THEN
    RAISE EXCEPTION 'HAS_TRAINED_FORBIDDEN: you do not control that academy or trainer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.player_owner_may_select_person(_owner_type, _owner_id, _person_id) THEN
    RAISE EXCEPTION 'HAS_TRAINED_NOT_IN_SCOPE: that Player is not in this scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.guest_player_id INTO v_guest
    FROM public.person_legacy_source(_person_id, _owner_type, _owner_id) s;
  IF v_guest IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.guest_players SET has_trained = true WHERE id = v_guest;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.person_mark_has_trained(uuid, text, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.person_mark_has_trained(uuid, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.person_mark_has_trained(uuid, text, uuid) IS
  'Sets has_trained on the person''s in-scope guest source, server-side. Replaces the browser UPDATE that keyed on a guest id received from the create flow. Person-keyed, scope-authorized; returns false when the person has no in-scope guest source to carry the flag.';
