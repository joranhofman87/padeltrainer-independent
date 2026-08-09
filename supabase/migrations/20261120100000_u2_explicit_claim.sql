-- U2 slice 2 — the explicit claim, and an idempotent server-side create.
--
-- Slice 1 stopped four writers from deciding identity on an email match. What it left behind is the
-- gap that makes that decision liveable: a guest who later signs up now has TWO Player records, and
-- until they say "that one is me" nobody may join them. This is that saying.
--
-- WHY A CLAIM CAN MERGE WHEN A MATCH CANNOT. The proposal is made by matching; the CLAIM is made by
-- the human, authenticated, acting on their own account. That is the difference D-04 draws —
-- "automated matching only proposes candidates; merges are audited and reversible/traceable" — and
-- it is enforced structurally rather than by convention: `person_claim_confirm` will only execute a
-- PENDING proposal that already exists for the caller's own profile. It cannot be handed an
-- arbitrary pair. There is no path from "these addresses match" to a merge that does not pass
-- through a person deciding.
--
-- WHAT IT IS NOT. It is not a second merge engine. The collapse itself is the reviewed
-- `collapse_guest_person_into_reporting` from U1c prerequisite 1 — the same one the operator merge
-- command uses, membership-aware and already tested. This adds authorization, idempotence and an
-- audit trail around it.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- What the signed-in person may claim
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Only proposals naming THEIR profile, only while pending, and only the guest's name plus where it
-- came from — enough to answer "is this you?" and nothing else. The guest is on their own address by
-- construction (that is why it was proposed), so the name is the one fact they need and the one they
-- can already infer.
CREATE OR REPLACE FUNCTION public.person_claim_candidates()
RETURNS TABLE (
  review_id       uuid,
  guest_player_id uuid,
  guest_name      text,
  academy_name    text,
  proposed_at     timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r.id, r.guest_player_id, g.full_name, a.name, r.created_at
    FROM public.person_merge_review r
    JOIN public.profiles p        ON p.id = r.suggested_profile_id
    JOIN public.guest_players g   ON g.id = r.guest_player_id
    LEFT JOIN public.academy_profiles a ON a.id = g.academy_profile_id
   WHERE r.kind = 'email_pair_awaiting_claim'
     AND r.status = 'pending'
     AND p.user_id = auth.uid()          -- their own account, taken from the token
     AND auth.uid() IS NOT NULL
   ORDER BY r.created_at;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The claim
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- IDEMPOTENT. A double-submitted claim, a retried request, a user who clicks twice: all return the
-- same answer and change nothing the second time. The proposal row is the idempotency key — once it
-- is `applied` there is nothing left to do, and the function says so rather than failing.
CREATE OR REPLACE FUNCTION public.person_claim_confirm(_review_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_review public.person_merge_review%ROWTYPE;
  v_profile_id uuid;
  v_guest_person uuid;
  v_profile_person uuid;
  v_collapse jsonb;
  v_linked jsonb;
  v_linked_profile uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'CLAIM_NOT_AUTHENTICATED: a claim is something a person makes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Lock the proposal first. Two concurrent claims of one proposal must not both collapse: the
  -- second would find the guest already relinked and could repoint a person that no longer exists.
  SELECT * INTO v_review FROM public.person_merge_review WHERE id = _review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLAIM_NOT_FOUND: no such claim' USING ERRCODE = 'no_data_found';
  END IF;

  -- The authorization AND the rule in one condition: it must be a claim proposal, and it must name
  -- the caller's own profile. Anything else is someone trying to merge two people they do not own.
  SELECT p.id INTO v_profile_id
    FROM public.profiles p
   WHERE p.id = v_review.suggested_profile_id AND p.user_id = v_uid;

  IF v_review.kind <> 'email_pair_awaiting_claim' OR v_profile_id IS NULL THEN
    -- deliberately the same message for "not yours" and "not a claim": a caller who may not act on
    -- this row should not learn from the error whether it exists
    RAISE EXCEPTION 'CLAIM_NOT_YOURS: this is not a claim you can make'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_review.status = 'applied' THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true, 'review_id', _review_id);
  END IF;
  IF v_review.status <> 'pending' THEN
    RAISE EXCEPTION 'CLAIM_NOT_PENDING: this claim was already resolved as %', v_review.status
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT person_id INTO v_profile_person FROM public.person_links WHERE profile_id = v_profile_id;
  SELECT person_id INTO v_guest_person   FROM public.person_links WHERE guest_player_id = v_review.guest_player_id;

  IF v_profile_person IS NULL OR v_guest_person IS NULL THEN
    RAISE EXCEPTION 'CLAIM_UNRESOLVABLE: one side of this claim has no person'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Already one person — the world moved on (an operator merge, an earlier claim). Not an error:
  -- the thing the caller asked for is true.
  IF v_guest_person = v_profile_person THEN
    UPDATE public.person_merge_review
       SET status = 'applied',
           details = coalesce(details, '{}'::jsonb)
                     || jsonb_build_object('resolved_by', 'already_one_person')
     WHERE id = _review_id;
    RETURN jsonb_build_object('ok', true, 'already_applied', true, 'review_id', _review_id);
  END IF;

  -- The guest must still be unclaimed — and it must STAY unclaimed while this decides. Reading the
  -- link and then writing it is a window an operator can walk through: they link the guest to
  -- account B, and the claimant overwrites it with A and collapses on top. Locking the proposal does
  -- not lock the guest, so the guest is locked here, before the value is read.
  SELECT g.linked_profile_id INTO v_linked_profile
    FROM public.guest_players g
   WHERE g.id = v_review.guest_player_id
     FOR UPDATE;

  IF v_linked_profile IS NOT NULL AND v_linked_profile <> v_profile_id THEN
    RAISE EXCEPTION 'CLAIM_TAKEN: that player is already linked to another account'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. Establish the association. This is the decision; everything after it executes the decision.
  -- The predicate repeats the check the lock now protects: belt, and a braces that costs nothing.
  UPDATE public.guest_players
     SET linked_profile_id = v_profile_id
   WHERE id = v_review.guest_player_id
     AND linked_profile_id IS DISTINCT FROM v_profile_id
     AND linked_profile_id IS NULL;

  -- Then verify it, rather than assume it. The lock above should make this impossible, and that is
  -- exactly why it is worth asserting: if the lock is ever weakened or removed, the collapse must
  -- not run against a guest that ended up belonging to somebody else. Correctness stops depending
  -- on the lock and starts depending on the state.
  SELECT g.linked_profile_id INTO v_linked_profile
    FROM public.guest_players g WHERE g.id = v_review.guest_player_id;
  IF v_linked_profile IS DISTINCT FROM v_profile_id THEN
    RAISE EXCEPTION 'CLAIM_TAKEN: that player is already linked to another account'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 2. One person. The reviewed, membership-aware collapse — not a second implementation of it.
  v_collapse := public.collapse_guest_person_into_reporting(
                  v_review.guest_player_id, v_guest_person, v_profile_person);

  IF NOT coalesce((v_collapse->>'ok')::boolean, false) THEN
    -- The collapse refuses when the guest's person is not safely collapsible. That is a real answer,
    -- not a failure to paper over: the association above stands, the persons stay separate, and the
    -- row becomes a review item for a human with more authority than the claimant.
    UPDATE public.person_merge_review
       SET kind = 'signup_pair_needs_review',
           details = coalesce(details, '{}'::jsonb)
                     || jsonb_build_object('claim_refused', 'guest person is not safely collapsible',
                                           'claimed_by_user', v_uid)
     WHERE id = _review_id;
    RETURN jsonb_build_object('ok', false, 'needs_review', true, 'review_id', _review_id);
  END IF;

  -- 3. The money rows the association now covers. Executing the decision, not making one.
  v_linked := public.link_guest_data_to_profile(v_profile_id);

  -- 4. The audit trail. `applied`, by whom, and what moved.
  UPDATE public.person_merge_review
     SET status = 'applied',
         person_id = v_profile_person,
         profile_id = v_profile_id,
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'resolved_by', 'user_claim',
           'claimed_by_user', v_uid,
           'memberships_moved',     coalesce((v_collapse->>'moved')::int, 0),
           'memberships_coalesced', coalesce((v_collapse->>'coalesced')::int, 0),
           'bookings_linked',       coalesce((v_linked->>'bookings_linked')::int, 0),
           'invoices_linked',       coalesce((v_linked->>'invoices_linked')::int, 0))
   WHERE id = _review_id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_applied', false,
    'review_id', _review_id,
    'person_id', v_profile_person,
    'memberships_moved',     coalesce((v_collapse->>'moved')::int, 0),
    'memberships_coalesced', coalesce((v_collapse->>'coalesced')::int, 0),
    'bookings_linked',       coalesce((v_linked->>'bookings_linked')::int, 0),
    'invoices_linked',       coalesce((v_linked->>'invoices_linked')::int, 0));
END;
$$;

-- The idempotent server-side create that slice 2 first drafted here deduplicated on address AND
-- name. That is still identity inferred from attributes, and the owner's decision on 2026-08-09
-- retired it before it ever ran anywhere: creation is keyed on a request UUID instead. The command
-- lives in 20261121100000, which is where the whole of it can be read at once.

REVOKE ALL ON FUNCTION public.person_claim_candidates() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.person_claim_confirm(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.person_claim_candidates() TO authenticated;
GRANT EXECUTE ON FUNCTION public.person_claim_confirm(uuid) TO authenticated;

COMMENT ON FUNCTION public.person_claim_confirm(uuid) IS
  'Executes a PENDING email_pair_awaiting_claim proposal that names the caller''s own profile. The only route from a proposed pair to one person, and it runs only when a person asks for it (U2, owner 2026-08-09). Idempotent: re-running an applied claim changes nothing.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The one guard the claim trips, and the narrowest carve-out that lets it through
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `protect_invoice_financial_columns_for_players` stops a signed-in player editing their own
-- invoice: status, amounts, dates, and crucially `player_id`, so nobody can reassign an invoice to or
-- away from themselves. It fires on `auth.uid()`, which a SECURITY DEFINER function does NOT clear —
-- JWT claims are request-local, not role-dependent. So the claim trips it: stamping a guest invoice
-- with the claimant's profile IS a change to `player_id` made by the person that invoice is about to
-- belong to.
--
-- (There is a second, superseded function raising the same message from an older migration. The
-- trigger calls THIS one — patching the other would have looked right and changed nothing, which is
-- what happened on the first attempt.)
--
-- The guard is right and stays. One transition is added and nothing else:
--
--     player_id: NULL → the caller's OWN profile
--
-- Deliberately NOT done: clearing `request.jwt.claims` inside the claim so the guard returns early.
-- That would work and it would be invisible — a function that quietly stops being the caller is a
-- trap for whoever reads it next.
CREATE OR REPLACE FUNCTION public.protect_invoice_financial_columns_for_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_player_profile_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_player_profile_id := public.get_profile_id_for_user(auth.uid());
  IF v_player_profile_id IS NULL OR NEW.player_id IS DISTINCT FROM v_player_profile_id THEN
    RETURN NEW;
  END IF;

  -- person-column-only updates are exempt (see header)
  IF to_jsonb(NEW) - 'person_id' = to_jsonb(OLD) - 'person_id' THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'invoice_locked'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
    OR NEW.vat_rate IS DISTINCT FROM OLD.vat_rate
    OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.line_items IS DISTINCT FROM OLD.line_items
    OR NEW.vat_breakdown IS DISTINCT FROM OLD.vat_breakdown
    OR NEW.mollie_payment_id IS DISTINCT FROM OLD.mollie_payment_id
    OR NEW.mollie_payment_url IS DISTINCT FROM OLD.mollie_payment_url
    OR NEW.booking_ids IS DISTINCT FROM OLD.booking_ids
    OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.trainer_id IS DISTINCT FROM OLD.trainer_id
    OR NEW.academy_profile_id IS DISTINCT FROM OLD.academy_profile_id
    OR NEW.guest_player_id IS DISTINCT FROM OLD.guest_player_id
    -- U2: the one transition claiming needs — an UNOWNED invoice being stamped with the caller's
    -- OWN profile. `OLD.player_id IS NULL` means it cannot move an invoice off another player, and
    -- `= v_player_profile_id` means it cannot move one onto anybody else. Every other change in this
    -- list is still refused in the same statement, so an invoice that already belongs to somebody is
    -- exactly as protected as it was.
    OR (NEW.player_id IS DISTINCT FROM OLD.player_id
        AND NOT (OLD.player_id IS NULL AND NEW.player_id = v_player_profile_id))
    OR NEW.player_name IS DISTINCT FROM OLD.player_name
    OR NEW.public_token IS DISTINCT FROM OLD.public_token
    OR NEW.public_token_revoked_at IS DISTINCT FROM OLD.public_token_revoked_at
    OR NEW.forwarded_at IS DISTINCT FROM OLD.forwarded_at
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.prices_include_vat IS DISTINCT FROM OLD.prices_include_vat
  THEN
    RAISE EXCEPTION 'players_may_only_update_billing_fields'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.protect_invoice_financial_columns_for_players() IS
  'Stops a signed-in player editing their own invoice. Since U2 it permits exactly one transition — an unowned invoice being stamped with the caller''s own profile, which is what claiming a guest record does. Everything else is refused as before.';
