-- Phase 0c hardening follow-through: make merge_guest_players aware of the explicit twin bridge
-- (guest_players.twin_of_profile_id, 20260826210000). Two changes against 20260706120100 — the
-- body is otherwise byte-identical:
--
--   1. GUARD: refuse the merge when the four person references (source/target ×
--      linked_profile_id/twin_of_profile_id) name MORE THAN ONE distinct profile. The old guard
--      only compared linked vs linked; a twin stamped for person A merged into a row linked to
--      person B would silently conflate two humans on one guest row. No behavior change for
--      existing data (twin_of_profile_id is new and NULL everywhere).
--   2. CARRY: the target inherits the source's twin stamp when it has none
--      (coalesce(target.twin, source.twin)) — merging a duplicate twin into the person's older
--      guest row must not LOSE the explicit person mapping, or the next roster add would re-mint
--      the duplicate that was just cleaned up. Safe against uniq_guest_twin_per_academy because
--      the source row is DELETEd before the target update (same ordering the email carry relies
--      on); a conflict with some THIRD row aborts the whole merge transaction cleanly.
CREATE OR REPLACE FUNCTION public.merge_guest_players(
  p_scope text,            -- 'academy' | 'trainer'
  p_scope_id uuid,
  p_source_guest_id uuid,
  p_target_guest_id uuid,
  p_fields jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source public.guest_players%ROWTYPE;
  v_target public.guest_players%ROWTYPE;
  v_trainer_ids uuid[];
  v_person_refs uuid[];
  v_bookings integer := 0;
  v_invoices integer := 0;
  v_intakes integer := 0;
  v_claims integer := 0;
  v_claims_dropped integer := 0;
  v_booking_dups integer := 0;
  v_meta_moved integer := 0;
  v_meta_merged integer := 0;
  v_notes integer := 0;
  v_locations integer := 0;
  v_locations_dropped integer := 0;
  v_captain_claims integer := 0;
  v_captain_bookings integer := 0;
  v_keep_email text;
  m record;
BEGIN
  IF p_source_guest_id = p_target_guest_id THEN
    RAISE EXCEPTION 'source and target are the same player';
  END IF;

  -- ---- authorization (explicit; the function bypasses RLS below) ----
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(array_agg(at.trainer_profile_id), '{}'::uuid[])
      INTO v_trainer_ids
      FROM public.academy_trainers at
     WHERE at.academy_profile_id = p_scope_id AND at.status = 'active';
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
    v_trainer_ids := ARRAY[p_scope_id];
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  SELECT * INTO v_source FROM public.guest_players WHERE id = p_source_guest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source player not found'; END IF;
  SELECT * INTO v_target FROM public.guest_players WHERE id = p_target_guest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target player not found'; END IF;

  -- both players must be members of the scope (same rules as the overview).
  -- coalesce() keeps the checks NULL-safe: a guest with a NULL owner column
  -- must be rejected, not slip through three-valued logic.
  IF p_scope = 'academy' THEN
    IF NOT (coalesce(v_source.academy_profile_id = p_scope_id, false)
              OR coalesce(v_source.trainer_id = ANY (v_trainer_ids), false))
       OR NOT (coalesce(v_target.academy_profile_id = p_scope_id, false)
              OR coalesce(v_target.trainer_id = ANY (v_trainer_ids), false)) THEN
      RAISE EXCEPTION 'both players must belong to the academy';
    END IF;
  ELSE
    IF v_source.trainer_id IS DISTINCT FROM p_scope_id
       OR v_target.trainer_id IS DISTINCT FROM p_scope_id THEN
      RAISE EXCEPTION 'both players must belong to the trainer';
    END IF;
  END IF;

  -- The two rows may reference at most ONE distinct person. Per ROW, the explicit manager
  -- assertion (twin_of_profile_id) OUTRANKS the email-inferred trigger link (linked_profile_id):
  -- the linked column has no name guard, so a stale family mislink (child's row linked to the
  -- parent) must not make an explicitly-twinned row unmergeable forever. ACROSS the two rows, two
  -- different effective references still refuse — never conflate two humans.
  SELECT coalesce(array_agg(DISTINCT p), '{}'::uuid[]) INTO v_person_refs
  FROM unnest(ARRAY[
    coalesce(v_source.twin_of_profile_id, v_source.linked_profile_id),
    coalesce(v_target.twin_of_profile_id, v_target.linked_profile_id)
  ]) AS p
  WHERE p IS NOT NULL;
  IF array_length(v_person_refs, 1) > 1 THEN
    RAISE EXCEPTION 'players reference two different accounts and cannot be merged';
  END IF;

  -- Email being kept on the target (source email is cleared before delete so
  -- applying it can never self-conflict).
  v_keep_email := CASE
    WHEN p_fields ? 'email' THEN nullif(btrim(p_fields->>'email'), '')
    ELSE v_target.email
  END;

  ------------------------------------------------------------------
  -- Metadata (tags, academy notes, removal): per owner, merge source's
  -- row into the target's (tags union, notes appended) or repoint it.
  ------------------------------------------------------------------
  FOR m IN
    SELECT * FROM public.academy_player_metadata
    WHERE guest_player_id = p_source_guest_id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.academy_player_metadata t
      WHERE t.guest_player_id = p_target_guest_id
        AND t.academy_profile_id IS NOT DISTINCT FROM m.academy_profile_id
        AND t.trainer_profile_id IS NOT DISTINCT FROM m.trainer_profile_id
    ) THEN
      UPDATE public.academy_player_metadata t
      SET tag_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[])
                     FROM unnest(t.tag_ids || m.tag_ids) AS x),
          notes = CASE
            WHEN nullif(btrim(coalesce(m.notes,'')),'') IS NULL THEN t.notes
            WHEN nullif(btrim(coalesce(t.notes,'')),'') IS NULL THEN m.notes
            ELSE t.notes || E'\n' || m.notes
          END
      WHERE t.guest_player_id = p_target_guest_id
        AND t.academy_profile_id IS NOT DISTINCT FROM m.academy_profile_id
        AND t.trainer_profile_id IS NOT DISTINCT FROM m.trainer_profile_id;
      DELETE FROM public.academy_player_metadata WHERE id = m.id;
      v_meta_merged := v_meta_merged + 1;
    ELSE
      UPDATE public.academy_player_metadata
      SET guest_player_id = p_target_guest_id
      WHERE id = m.id;
      v_meta_moved := v_meta_moved + 1;
    END IF;
  END LOOP;

  ------------------------------------------------------------------
  -- Repoint relations
  ------------------------------------------------------------------
  -- bookings: unique per (slot, guest) for active rows (M-17 index) — when both
  -- players actively book the same slot, cancel the redundant one BEFORE the
  -- repoint or the UPDATE would violate uniq_active_booking_per_slot_guest.
  -- Keep the paid booking; on a tie keep the target's.
  FOR m IN
    SELECT sb.id AS source_booking_id, tb.id AS target_booking_id,
           (sb.payment_status = 'paid' OR coalesce(sb.paid_externally, false)) AS source_paid,
           (tb.payment_status = 'paid' OR coalesce(tb.paid_externally, false)) AS target_paid
    FROM public.bookings sb
    JOIN public.bookings tb
      ON tb.slot_id = sb.slot_id
     AND tb.guest_player_id = p_target_guest_id
     AND tb.status IN ('pending','confirmed','completed')
    WHERE sb.guest_player_id = p_source_guest_id
      AND sb.status IN ('pending','confirmed','completed')
  LOOP
    IF m.source_paid AND NOT m.target_paid THEN
      UPDATE public.bookings SET status = 'cancelled' WHERE id = m.target_booking_id;
    ELSE
      UPDATE public.bookings SET status = 'cancelled' WHERE id = m.source_booking_id;
    END IF;
    v_booking_dups := v_booking_dups + 1;
  END LOOP;

  UPDATE public.bookings SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_bookings = ROW_COUNT;

  UPDATE public.invoices SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_invoices = ROW_COUNT;

  UPDATE public.intake_requests SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_intakes = ROW_COUNT;

  -- priority claims: unique per (slot, guest) — drop source claims where the
  -- target already has one on the same slot, repoint the rest
  DELETE FROM public.slot_priority_claims s
  WHERE s.guest_player_id = p_source_guest_id
    AND EXISTS (SELECT 1 FROM public.slot_priority_claims t
                WHERE t.slot_id = s.slot_id
                  AND t.guest_player_id = p_target_guest_id);
  GET DIAGNOSTICS v_claims_dropped = ROW_COUNT;

  UPDATE public.slot_priority_claims SET guest_player_id = p_target_guest_id
  WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_claims = ROW_COUNT;

  ------------------------------------------------------------------
  -- Repoint the CASCADE + SET-NULL children the previous body ignored
  -- (P1-3). Without these the DELETE below cascades away coaching notes and
  -- manually-curated club rows and nulls the captain attribution markers.
  ------------------------------------------------------------------
  -- session_player_notes: ON DELETE CASCADE, no unique constraint on the
  -- subject column -> a plain repoint cannot collide.
  UPDATE public.session_player_notes
     SET subject_guest_player_id = p_target_guest_id
   WHERE subject_guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  -- academy_player_locations: ON DELETE CASCADE, partial unique apl_uniq_guest
  -- (academy_profile_id, guest_player_id, location_id) WHERE guest_player_id IS NOT NULL.
  -- Same dedup-then-repoint as slot_priority_claims: drop the source row where the
  -- target already has one for the same (academy, location) (keep the target's flag),
  -- then repoint the rest.
  DELETE FROM public.academy_player_locations s
  WHERE s.guest_player_id = p_source_guest_id
    AND EXISTS (SELECT 1 FROM public.academy_player_locations t
                WHERE t.guest_player_id = p_target_guest_id
                  AND t.academy_profile_id = s.academy_profile_id
                  AND t.location_id = s.location_id);
  GET DIAGNOSTICS v_locations_dropped = ROW_COUNT;

  UPDATE public.academy_player_locations
     SET guest_player_id = p_target_guest_id
   WHERE guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_locations = ROW_COUNT;

  -- Group-captain attribution markers (ON DELETE SET NULL): the source guest may be
  -- the captain who booked/paid for other members. Repoint so the surviving guest
  -- keeps the "who booked/paid for whom" link instead of it being nulled. No unique
  -- constraint on these columns -> plain UPDATE.
  UPDATE public.slot_priority_claims
     SET booked_by_guest_player_id = p_target_guest_id
   WHERE booked_by_guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_captain_claims = ROW_COUNT;

  UPDATE public.bookings
     SET paid_by_guest_player_id = p_target_guest_id
   WHERE paid_by_guest_player_id = p_source_guest_id;
  GET DIAGNOSTICS v_captain_bookings = ROW_COUNT;

  ------------------------------------------------------------------
  -- Clear the source's email before deleting it so applying the kept email
  -- to the target can never trip the partial unique indexes.
  ------------------------------------------------------------------
  UPDATE public.guest_players SET email = NULL WHERE id = p_source_guest_id;

  DELETE FROM public.guest_players WHERE id = p_source_guest_id;

  ------------------------------------------------------------------
  -- Apply kept personal fields + combined flags to the target
  ------------------------------------------------------------------
  UPDATE public.guest_players t
  SET
    full_name        = CASE WHEN p_fields ? 'full_name' THEN coalesce(nullif(btrim(p_fields->>'full_name'),''), t.full_name) ELSE t.full_name END,
    first_name       = CASE WHEN p_fields ? 'first_name' THEN nullif(btrim(p_fields->>'first_name'),'') ELSE t.first_name END,
    last_name        = CASE WHEN p_fields ? 'last_name' THEN nullif(btrim(p_fields->>'last_name'),'') ELSE t.last_name END,
    email            = v_keep_email,
    phone            = CASE WHEN p_fields ? 'phone' THEN nullif(btrim(p_fields->>'phone'),'') ELSE t.phone END,
    skill_rating     = CASE WHEN p_fields ? 'skill_rating' THEN (p_fields->>'skill_rating')::numeric ELSE t.skill_rating END,
    rating_system    = CASE WHEN p_fields ? 'rating_system' THEN coalesce(nullif(btrim(p_fields->>'rating_system'),''), t.rating_system) ELSE t.rating_system END,
    birth_date       = CASE WHEN p_fields ? 'birth_date' THEN nullif(btrim(p_fields->>'birth_date'),'')::date ELSE t.birth_date END,
    notes            = CASE WHEN p_fields ? 'notes' THEN nullif(btrim(p_fields->>'notes'),'') ELSE t.notes END,
    billing_business_name = CASE WHEN p_fields ? 'billing_business_name' THEN nullif(btrim(p_fields->>'billing_business_name'),'') ELSE t.billing_business_name END,
    billing_address  = CASE WHEN p_fields ? 'billing_address' THEN nullif(btrim(p_fields->>'billing_address'),'') ELSE t.billing_address END,
    billing_btw_number = CASE WHEN p_fields ? 'billing_btw_number' THEN nullif(btrim(p_fields->>'billing_btw_number'),'') ELSE t.billing_btw_number END,
    preferred_location_id = CASE WHEN p_fields ? 'preferred_location_id' THEN nullif(btrim(p_fields->>'preferred_location_id'),'')::uuid ELSE t.preferred_location_id END,
    source           = CASE WHEN p_fields ? 'source' THEN nullif(btrim(p_fields->>'source'),'') ELSE t.source END,
    has_trained      = t.has_trained OR coalesce(v_source.has_trained, false),
    linked_profile_id = coalesce(t.linked_profile_id, v_source.linked_profile_id),
    twin_of_profile_id = coalesce(t.twin_of_profile_id, v_source.twin_of_profile_id)
  WHERE t.id = p_target_guest_id;

  RETURN jsonb_build_object(
    'target_guest_id', p_target_guest_id,
    'bookings_moved', v_bookings,
    'invoices_moved', v_invoices,
    'intake_requests_moved', v_intakes,
    'priority_claims_moved', v_claims,
    'priority_claims_deduped', v_claims_dropped,
    'bookings_deduped', v_booking_dups,
    'metadata_rows_moved', v_meta_moved,
    'metadata_rows_merged', v_meta_merged,
    'notes_moved', v_notes,
    'locations_moved', v_locations,
    'locations_deduped', v_locations_dropped,
    'captain_claim_markers_moved', v_captain_claims,
    'captain_booking_markers_moved', v_captain_bookings
  );
END;
$$;
