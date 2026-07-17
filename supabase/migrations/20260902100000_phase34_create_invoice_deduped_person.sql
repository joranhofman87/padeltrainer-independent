-- Phase 3.4 (money path, dedup-only): person-key create_invoice_deduped's
-- double-bill guard.
--
-- SCOPE (owner: "Dedup/grouping only", amount math UNCHANGED):
--   create_invoice_deduped is the atomic per-(trainer,recipient) invoice-create
--   guard (P1-6). Its dedup keyed the advisory lock + the overlap recheck on the
--   OLD-WORLD ref (player_id XOR guest_player_id). After person unification a
--   single person can hold BOTH a profile ref AND a guest ref, so two creates for
--   the SAME bookings under the two different keys took DIFFERENT locks and the
--   recheck's per-key match missed the sibling — inserting a SECOND active invoice
--   for the same person's same bookings (a cross-key double charge that the
--   original P1-6 fix closed only for same-key concurrency).
--
-- FIX: resolve the incoming recipient to a PERSON (guest-first, byte-identical to
--   stamp_person_id_invoices) and
--     (a) key the advisory lock on the person (when linked) so cross-key concurrent
--         creates for one person serialize on ONE lock; and
--     (b) add a person arm to the overlap recheck (i.person_id = v_person_id) so the
--         serialized second create FINDS the sibling and returns it (deduped=true)
--         instead of inserting.
--   The booking-overlap gate (i.booking_ids && v_booking_ids) is UNCHANGED, so this
--   is a pure double-bill guard: it only ever returns a PRE-EXISTING invoice that
--   already bills the SAME bookings — it never merges distinct charges, never
--   changes a total, and never divides. Amount math is untouched.
--
-- CONGRUENT DEGRADATION: an unlinked / pre-backfill recipient resolves v_person_id
--   to NULL, the lock key falls back to the exact pre-3.4 per-key string, and the
--   person arm is inert (v_person_id IS NOT NULL is false) — behaviour is
--   byte-identical to P1-6. An unstamped existing invoice (person_id NULL) is still
--   caught by the retained per-key arms. Never weaker than today.
--
-- NOT IN THIS PHASE (amount-affecting divisors, deferred to an explicit money-amount
--   phase per the owner's "amounts unchanged" bar):
--     * split-invoice's Object.keys(playerBookings).length — that grouping count IS
--       the split divisor N (baseCents = floor(total/N)); collapsing a person's two
--       keys there would change N and therefore every share.
--     * _shared/cycle-commitment-invoicing.ts group.size (headcount divisor).
--   Both are recipient-COUNT math, not recipient dedup, so they stay out of scope.
--
-- Signature unchanged (jsonb -> jsonb): CREATE OR REPLACE, no types.ts drift.

CREATE OR REPLACE FUNCTION public.create_invoice_deduped(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trainer_id uuid := (_payload->>'trainer_id')::uuid;
  v_player_id uuid := NULLIF(_payload->>'player_id', '')::uuid;
  v_guest_player_id uuid := NULLIF(_payload->>'guest_player_id', '')::uuid;
  v_person_id uuid;
  v_booking_ids uuid[];
  v_recipient_key text;
  v_winner public.invoices%ROWTYPE;
  v_new public.invoices%ROWTYPE;
BEGIN
  IF v_trainer_id IS NULL THEN RAISE EXCEPTION 'create_invoice_deduped: trainer_id is required'; END IF;
  SELECT COALESCE(array_agg(elem::uuid), '{}'::uuid[]) INTO v_booking_ids
  FROM jsonb_array_elements_text(COALESCE(_payload->'booking_ids', '[]'::jsonb)) AS elem;

  -- Phase 3.4: resolve the recipient to a PERSON, guest-first (byte-identical to
  -- stamp_person_id_invoices). person_links.profile_id / .guest_player_id are both
  -- UNIQUE, so each subquery yields at most one row. NULL = unlinked recipient ->
  -- lock + recheck degrade to the exact pre-3.4 per-key behaviour.
  v_person_id := COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = v_guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = v_player_id)
  );

  -- Person-keyed lock (falls back to the old per-key string when unlinked) so that
  -- cross-key concurrent creates for ONE person serialize on the same lock.
  v_recipient_key := v_trainer_id::text || ':' ||
    COALESCE(v_person_id::text, v_player_id::text, v_guest_player_id::text, 'none');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_recipient_key, 0));
  IF array_length(v_booking_ids, 1) > 0 THEN
    SELECT i.* INTO v_winner FROM public.invoices i
    WHERE i.trainer_id = v_trainer_id AND i.status <> 'cancelled' AND i.booking_ids && v_booking_ids
      AND ((v_player_id IS NOT NULL AND i.player_id = v_player_id)
        OR (v_player_id IS NULL AND v_guest_player_id IS NOT NULL AND i.guest_player_id = v_guest_player_id)
        -- Phase 3.4: sibling under the person's OTHER key, same bookings.
        OR (v_person_id IS NOT NULL AND i.person_id = v_person_id))
    ORDER BY i.created_at ASC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_winner.id, 'invoice_number', v_winner.invoice_number,
        'status', v_winner.status, 'sent_at', v_winner.sent_at,
        'booking_ids', to_jsonb(v_winner.booking_ids), 'total', v_winner.total, 'deduped', true);
    END IF;
  END IF;
  INSERT INTO public.invoices (
    trainer_id, academy_profile_id, invoice_number, invoice_date, due_date, player_id, guest_player_id,
    player_name, player_business_name, player_address, player_btw_number, line_items, subtotal, vat_rate,
    vat_amount, total, vat_breakdown, prices_include_vat, status, booking_ids, split_count, paid_at, sent_at
  ) VALUES (
    v_trainer_id, NULLIF(_payload->>'academy_profile_id', '')::uuid, _payload->>'invoice_number',
    (_payload->>'invoice_date')::date, (_payload->>'due_date')::date, v_player_id, v_guest_player_id,
    _payload->>'player_name', _payload->>'player_business_name', _payload->>'player_address',
    _payload->>'player_btw_number', COALESCE(_payload->'line_items', '[]'::jsonb),
    COALESCE((_payload->>'subtotal')::numeric, 0), COALESCE((_payload->>'vat_rate')::numeric, 21),
    COALESCE((_payload->>'vat_amount')::numeric, 0), COALESCE((_payload->>'total')::numeric, 0),
    CASE WHEN _payload ? 'vat_breakdown' THEN _payload->'vat_breakdown' ELSE NULL END,
    COALESCE((_payload->>'prices_include_vat')::boolean, true), COALESCE(_payload->>'status', 'draft'),
    v_booking_ids, NULLIF(_payload->>'split_count', '')::integer,
    NULLIF(_payload->>'paid_at', '')::timestamptz, NULLIF(_payload->>'sent_at', '')::timestamptz
  ) RETURNING * INTO v_new;
  RETURN jsonb_build_object('id', v_new.id, 'invoice_number', v_new.invoice_number,
    'status', v_new.status, 'sent_at', v_new.sent_at,
    'booking_ids', to_jsonb(v_new.booking_ids), 'total', v_new.total, 'deduped', false);
END; $$;

COMMENT ON FUNCTION public.create_invoice_deduped(jsonb) IS
  'P1-6 + Phase 3.4: atomic per-(trainer,PERSON) invoice create. Advisory-locked overlap dedup + insert in one txn; the lock + overlap recheck are person-keyed (guest-first via person_links) so a merged person cannot be double-billed across their profile/guest keys, degrading to per-key when unlinked. Auth-gated caller only (auto-create-invoice runs the caller ownership checks); not for anon.';

-- SECURITY DEFINER: re-assert the P1-6 grants (CREATE OR REPLACE preserves them,
-- re-emitting is idempotent). authenticated MUST keep EXECUTE (auto-create-invoice
-- calls it as the trainer/academy user); cron/service paths use service_role.
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_deduped(jsonb) TO authenticated, service_role;
