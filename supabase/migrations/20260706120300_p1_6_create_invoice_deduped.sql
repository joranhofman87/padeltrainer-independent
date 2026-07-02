-- P1-6: atomic per-recipient invoice creation to close the auto-create-invoice
-- double-bill race.
--
-- auto-create-invoice deduped concurrent invoices with a non-transactional
-- .overlaps('booking_ids', ids) SELECT followed by a separate INSERT (two
-- supabase-js round-trips, each its own txn). The only DB backstop
-- (uniq_invoice_active_player_bookings / _guest_, keyed on md5 of the EXACT
-- sorted booking set) catches only IDENTICAL sets. So two concurrent
-- same-recipient calls with overlapping-but-unequal sets (e.g. [A] and [A,B])
-- both passed the read guard and both inserted, billing booking A on two
-- active invoices — a double charge.
--
-- create_invoice_deduped runs the overlap dedup recheck AND the INSERT inside a
-- single transaction guarded by pg_advisory_xact_lock on the (trainer, recipient)
-- key, so concurrent same-recipient calls serialize: the second sees the first's
-- committed invoice and returns it (deduped=true) instead of inserting a second.
-- On an invoice-NUMBER unique collision the INSERT still raises 23505 with the
-- unique_invoice_number_per_* constraint name, so the caller's reallocate-and-retry
-- loop keeps working.

CREATE OR REPLACE FUNCTION public.create_invoice_deduped(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_trainer_id uuid := (_payload->>'trainer_id')::uuid;
  v_player_id uuid := NULLIF(_payload->>'player_id', '')::uuid;
  v_guest_player_id uuid := NULLIF(_payload->>'guest_player_id', '')::uuid;
  v_booking_ids uuid[];
  v_recipient_key text;
  v_winner public.invoices%ROWTYPE;
  v_new public.invoices%ROWTYPE;
BEGIN
  IF v_trainer_id IS NULL THEN RAISE EXCEPTION 'create_invoice_deduped: trainer_id is required'; END IF;
  SELECT COALESCE(array_agg(elem::uuid), '{}'::uuid[]) INTO v_booking_ids
  FROM jsonb_array_elements_text(COALESCE(_payload->'booking_ids', '[]'::jsonb)) AS elem;
  v_recipient_key := v_trainer_id::text || ':' || COALESCE(v_player_id::text, v_guest_player_id::text, 'none');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_recipient_key, 0));
  IF array_length(v_booking_ids, 1) > 0 THEN
    SELECT i.* INTO v_winner FROM public.invoices i
    WHERE i.trainer_id = v_trainer_id AND i.status <> 'cancelled' AND i.booking_ids && v_booking_ids
      AND ((v_player_id IS NOT NULL AND i.player_id = v_player_id)
        OR (v_player_id IS NULL AND v_guest_player_id IS NOT NULL AND i.guest_player_id = v_guest_player_id))
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
  'P1-6: atomic per-(trainer,recipient) invoice create. Advisory-locked overlap dedup + insert in one txn. Auth-gated caller only (auto-create-invoice runs the caller ownership checks); not for anon.';

-- The function is SECURITY DEFINER, so lock EXECUTE down. The non-cron caller
-- (auto-create-invoice) invokes it as the authenticated user, so authenticated
-- MUST retain EXECUTE (a service_role-only grant would 403 every trainer/academy
-- invoice creation); cron/service paths use service_role.
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_deduped(jsonb) TO authenticated, service_role;
