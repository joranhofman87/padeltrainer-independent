-- Rebook go-live (Workstream B, B2): linked-guest VISIBILITY for the player agenda + bookings list.
--
-- A player's agenda / bookings page / dashboard read bookings with .eq('player_id', me) — so a
-- session booked ON BEHALF of the player (academy add, group-captain rebook) under a guest record
-- LINKED to their profile (guest_players.linked_profile_id) is invisible: the booking is keyed by
-- guest_player_id with player_id NULL, and the player cannot SELECT guest-keyed bookings/invoices
-- under RLS (bookings/invoices SELECT policies are player_id-only; players have no guest_players
-- SELECT policy → PII). We expose two narrow SECURITY DEFINER readers scoped strictly to the
-- caller's own identity. The client keeps its existing player_id queries untouched and MERGES these
-- supplementary linked-guest rows in — so the player_id read path (and its slot-visibility rules)
-- is byte-identical; this only ADDS the linked-guest rows the player otherwise can't see.
--
-- Both are keyed on the EXPLICIT linked_profile_id link ONLY — never email — consistent with
-- get_my_pending_priority_claims (20260703120000) and the signup linker (20260530190000), so they
-- never widen visibility beyond what the link already decided.

-- 1) The caller's linked-guest-keyed bookings (player_id IS NULL → the rows the player_id query
--    can't return), joined to slot + location, returned in the exact nested shape the client's
--    slotSelect produces (so the existing enrich/map code consumes them unchanged). max_participants
--    + location_id are included so PlayerAgenda (which needs them) can reuse the same rows.
CREATE OR REPLACE FUNCTION public.get_my_linked_guest_bookings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
  v_result jsonb;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN '[]'::jsonb;  -- not a known player → no rows
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', b.id,
      'slot_id', b.slot_id,
      'status', b.status,
      'payment_status', b.payment_status,
      'paid_externally', b.paid_externally,
      'notes', b.notes,
      'created_at', b.created_at,
      'availability_slots', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
        'start_time', s.start_time,
        'end_time', s.end_time,
        'trainer_id', s.trainer_id,
        'max_participants', s.max_participants,
        'price_per_session', s.price_per_session,
        'cyclus_name', s.cyclus_name,
        'location_id', s.location_id,
        'locations', CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('name', l.name) END
      ) END
    )
  ), '[]'::jsonb)
  INTO v_result
  FROM public.bookings b
  LEFT JOIN public.availability_slots s ON s.id = b.slot_id
  LEFT JOIN public.locations l ON l.id = s.location_id
  WHERE b.player_id IS NULL
    AND b.guest_player_id IN (
      SELECT gp.id FROM public.guest_players gp WHERE gp.linked_profile_id = v_profile
    );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_linked_guest_bookings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_linked_guest_bookings() TO authenticated;

-- 2) The set of booking ids covered by a PAID invoice for the caller OR a guest linked to them.
--    Replaces the player_id-only invoices read in enrichBookings so the paid/unpaid override is
--    correct for linked-guest bookings too (their invoice is keyed by guest_player_id).
CREATE OR REPLACE FUNCTION public.get_my_paid_booking_ids()
RETURNS TABLE (booking_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;  -- not a known player → no rows
  END IF;

  RETURN QUERY
  SELECT DISTINCT bid
  FROM public.invoices i
  CROSS JOIN LATERAL unnest(coalesce(i.booking_ids, '{}'::uuid[])) AS bid
  WHERE i.status = 'paid'
    AND (
      i.player_id = v_profile
      OR i.guest_player_id IN (
        SELECT gp.id FROM public.guest_players gp WHERE gp.linked_profile_id = v_profile
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_paid_booking_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_paid_booking_ids() TO authenticated;
