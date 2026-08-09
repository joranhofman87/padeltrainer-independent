-- U2 slice 1 — email alone never authorizes an identity merge.
--
-- THE DECISION (owner, 2026-08-09): disable B2 and the legacy email linker from the active merge
-- path. No auto-merge on email or on any weaker inference. U2 uses explicit claim/merge semantics
-- only. This supersedes rule B2 (locked 2026-07-16) and settles the nonconformance to D-04 recorded
-- in `FOUNDATION_DECISIONS.md` on 2026-08-07.
--
-- WHAT WAS INFERRING IDENTITY FROM AN EMAIL STRING. Three sites, not the one the record names:
--
--   H1 `mint_person_for_profile` — at signup, if exactly one profile and exactly one guest carried
--      the address, it COLLAPSED the guest's person into the new profile's.
--   H2 `mint_person_for_guest` — the same rule from the other side: a new guest whose email matched
--      exactly one profile was minted onto that profile's person rather than its own.
--   `link_guest_data_to_profile` — the one the record does not mention, and the one that touches
--      MONEY. It stamps `bookings.player_id` and `invoices.player_id`, it has a WEAKER guard than B2
--      (it never checks how many profiles share the address), and it fires first in the same signup
--      transaction. Disabling B2 alone would have removed the audited, uniqueness-checked merge and
--      left the unaudited, weaker-guarded one running.
--
-- WHAT REPLACES THEM. D-04's own consequence column: "automated matching only proposes candidates;
-- merges are audited and reversible/traceable." So the matching still happens and still records what
-- it found — as a PENDING `person_merge_review` row, which is a proposal — and nothing is collapsed
-- until a human claims it. Slice 2 adds that claim command.
--
-- WHAT IS DELIBERATELY KEPT. B1, the twin-trust arm: `twin_of_profile_id` is an EXPLICIT operator
-- assertion that this guest is that account holder, and it is verified against the email rather than
-- derived from it. An explicit assertion is the second signal D-04 asks for, so it stays. And
-- `link_guest_data_to_profile` keeps its `linked_profile_id` arm: an established association is a
-- decision someone already made, and stamping money rows to honour it is executing that decision,
-- not inferring a new one. That arm is what slice 2's claim command will drive.
--
-- CONSEQUENCE, STATED. A guest who later signs up with the same address now has TWO persons until
-- they claim. They will appear twice in academy player lists and be counted twice in dashboards
-- until the claim happens. That is the visible cost of not guessing, and it is the outcome the
-- owner chose over an irreversible automatic merge.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- H1 — the profile side
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mint_person_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_guest uuid;
  v_guest_person uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE profile_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('guest_email:' || lower(v_email)));
  END IF;

  INSERT INTO public.persons (
    id, user_id, full_name, first_name, last_name, email, phone, birth_date,
    skill_rating, rating_system, rating_member_id, avatar_url, bio, location,
    preferred_language, billing_business_name, billing_address, billing_btw_number,
    stripe_customer_id
  ) VALUES (
    NEW.id, NEW.user_id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
    NEW.skill_rating, NEW.rating_system, NEW.rating_member_id, NEW.avatar_url, NEW.bio, NEW.location,
    NEW.preferred_language, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number,
    NEW.stripe_customer_id
  ) ON CONFLICT (id) DO NOTHING;
  v_person := NEW.id;
  INSERT INTO public.person_links (person_id, profile_id) VALUES (v_person, NEW.id);

  -- The account-claim shape: a guest existed first and the human has now signed up with that
  -- address. This used to collapse. It now PROPOSES — the row is pending, nothing is merged, and the
  -- two persons stay separate until someone claims one into the other.
  IF v_email IS NOT NULL
     AND (SELECT count(*) FROM public.guest_players g
          WHERE lower(btrim(g.email)) = lower(v_email)
            AND nullif(btrim(g.email), '') IS NOT NULL) = 1 THEN
    SELECT g.id INTO v_guest FROM public.guest_players g
    WHERE lower(btrim(g.email)) = lower(v_email) AND nullif(btrim(g.email), '') IS NOT NULL;
    SELECT person_id INTO v_guest_person FROM public.person_links WHERE guest_player_id = v_guest;

    IF v_guest_person IS NOT NULL AND v_guest_person <> v_person THEN
      INSERT INTO public.person_merge_review
        (kind, status, email, guest_player_id, profile_id, suggested_profile_id, details)
      VALUES ('email_pair_awaiting_claim', 'pending', v_email, v_guest, NEW.id, NEW.id,
              jsonb_build_object(
                'via', 'signup_pair',
                'note', 'proposed only — email alone does not authorize a merge (U2, owner 2026-08-09)'));
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- H2 — the guest side
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mint_person_for_guest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_profile_email text;
  v_guest_count int := 0;
  v_profile_count int := 0;
  v_merged_kind text;
  v_merged_profile uuid;
  v_candidate_profile uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE guest_player_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Serialize same-email guest inserts: two concurrent inserts of one family email could BOTH see
  -- themselves as the only guest with it. Still needed — the counts now drive a PROPOSAL, and a
  -- proposal raised twice for one pair is still noise a human has to sort out.
  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('guest_email:' || lower(v_email)));
    SELECT count(*) INTO v_guest_count FROM public.guest_players g
    WHERE lower(btrim(g.email)) = lower(v_email) AND nullif(btrim(g.email), '') IS NOT NULL;
    SELECT count(*) INTO v_profile_count FROM public.profiles p
    WHERE lower(btrim(p.email)) = lower(v_email) AND nullif(btrim(p.email), '') IS NOT NULL;
  END IF;

  -- B1 KEPT: an explicit `twin_of_profile_id` assertion, verified against the email rather than
  -- derived from it. An operator saying "this guest is that account holder" is the second signal.
  IF NEW.twin_of_profile_id IS NOT NULL THEN
    SELECT nullif(btrim(p.email), '') INTO v_profile_email
    FROM public.profiles p WHERE p.id = NEW.twin_of_profile_id;
    IF (v_email IS NOT NULL AND v_profile_email IS NOT NULL
        AND lower(v_email) = lower(v_profile_email))
       OR (v_email IS NULL AND NEW.source = 'roster_registered_twin') THEN
      SELECT person_id INTO v_person FROM public.person_links
      WHERE profile_id = NEW.twin_of_profile_id;
      IF v_person IS NOT NULL THEN
        v_merged_kind := 'auto_merged_twin_trust';
        v_merged_profile := NEW.twin_of_profile_id;
      END IF;
    ELSE
      INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, details)
      VALUES ('twin_trust_failure', NEW.email, NEW.id, NEW.twin_of_profile_id,
              jsonb_build_object('guest_name', NEW.full_name, 'via', 'live_insert'));
    END IF;
  END IF;

  -- B2 RETIRED: a unique email pair no longer mints this guest onto the profile's person. It gets
  -- its own person and the pair is proposed for a claim.
  IF v_person IS NULL AND v_email IS NOT NULL
     AND v_guest_count = 1 AND v_profile_count = 1 THEN
    SELECT pl.profile_id INTO v_candidate_profile
    FROM public.person_links pl
    JOIN public.profiles p ON p.id = pl.profile_id
    WHERE lower(btrim(p.email)) = lower(v_email);

    IF v_candidate_profile IS NOT NULL THEN
      INSERT INTO public.person_merge_review
        (kind, status, email, guest_player_id, profile_id, suggested_profile_id, details)
      VALUES ('email_pair_awaiting_claim', 'pending', v_email, NEW.id, NULL, v_candidate_profile,
              jsonb_build_object(
                'via', 'guest_insert',
                'note', 'proposed only — email alone does not authorize a merge (U2, owner 2026-08-09)'));
    END IF;
  END IF;

  IF v_person IS NULL THEN
    INSERT INTO public.persons (
      id, full_name, first_name, last_name, email, phone, birth_date,
      skill_rating, rating_system, billing_business_name, billing_address, billing_btw_number
    ) VALUES (
      NEW.id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
      NEW.skill_rating, NEW.rating_system, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number
    ) ON CONFLICT (id) DO NOTHING;
    v_person := NEW.id;
  END IF;

  INSERT INTO public.person_links (person_id, guest_player_id) VALUES (v_person, NEW.id);

  IF v_merged_kind IS NOT NULL THEN
    PERFORM public.rederive_person(v_person);  -- the new guest may fill gaps on the merged person
  END IF;

  -- observability parity with the backfill's E report
  IF v_merged_kind IS NOT NULL THEN
    INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
    VALUES (v_merged_kind, 'applied', NEW.email, NEW.id, v_merged_profile, v_person,
            jsonb_build_object('guest_name', NEW.full_name, 'via', 'live_insert'));
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The money path — execute an established association, never infer a new one
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The email-match arm is gone. What remains is the `linked_profile_id` arm: a link someone
-- deliberately established, whose bookings and invoices should carry the account's player_id. That
-- is executing a decision, not making one — and it is exactly what the claim command will call.
CREATE OR REPLACE FUNCTION public.link_guest_data_to_profile(_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_bookings_linked int := 0;
  v_invoices_linked int := 0;
BEGIN
  IF _profile_id IS NULL THEN
    RETURN jsonb_build_object('profile_id', NULL, 'guest_players_linked', 0,
                              'bookings_linked', 0, 'invoices_linked', 0);
  END IF;

  UPDATE public.bookings b
  SET player_id = _profile_id
  FROM public.guest_players gp
  WHERE b.guest_player_id = gp.id
    AND gp.linked_profile_id = _profile_id
    AND b.player_id IS NULL;
  GET DIAGNOSTICS v_bookings_linked = ROW_COUNT;

  UPDATE public.invoices i
  SET player_id = _profile_id
  FROM public.guest_players gp
  WHERE i.guest_player_id = gp.id
    AND gp.linked_profile_id = _profile_id
    AND i.player_id IS NULL;
  GET DIAGNOSTICS v_invoices_linked = ROW_COUNT;

  RETURN jsonb_build_object(
    'profile_id', _profile_id,
    -- always 0 now: this function no longer establishes a link, it only honours one. The key stays
    -- so existing callers reading it keep working.
    'guest_players_linked', 0,
    'bookings_linked', v_bookings_linked,
    'invoices_linked', v_invoices_linked
  );
END;
$$;

COMMENT ON FUNCTION public.link_guest_data_to_profile(uuid) IS
  'Stamps player_id on the bookings/invoices of guests ALREADY linked to this profile (linked_profile_id). It does not match on email and does not establish links — U2 (owner 2026-08-09) removed that arm, because email alone never authorizes an identity merge. Idempotent; never overwrites player_id.';

COMMENT ON FUNCTION public.mint_person_for_profile() IS
  'Mints the canonical person for a new profile. A guest sharing the address is PROPOSED as email_pair_awaiting_claim, never collapsed — see U2, owner decision 2026-08-09.';

COMMENT ON FUNCTION public.mint_person_for_guest() IS
  'Mints the canonical person for a new guest. Keeps B1 twin-trust (an explicit, verified operator assertion); rule B2 is retired — a unique email pair is PROPOSED as email_pair_awaiting_claim, never merged.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- H3 — conforming, and hardened while its two siblings were
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `relink_person_on_twin_change` collapses only when `twin_of_profile_id` CHANGES to a non-null
-- value — an explicit operator assertion, with the email used to VERIFY it rather than to infer it.
-- That conforms to the decision and its behaviour is deliberately unchanged. What is changed is the
-- search path: it was `SET search_path TO 'public'`, and leaving one of three sibling SECURITY
-- DEFINER identity writers unpinned after hardening the other two is worse than not having started.
-- Behaviour-identical; only the resolution order moves.
ALTER FUNCTION public.relink_person_on_twin_change()
  SET search_path = pg_catalog, public, pg_temp;

COMMENT ON FUNCTION public.relink_person_on_twin_change() IS
  'Relinks a guest person when its twin stamp changes. Merges ONLY on an explicit twin_of_profile_id assertion, verified against the email — never on an email match alone (U2, owner 2026-08-09).';
