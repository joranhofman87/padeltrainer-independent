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
-- SPLIT-FREEZE (external audit P2, folded in — the doctrine applied on every person
--   arm since 3.1): a guest with a pending twin_detached_needs_split /
--   merged_guest_email_moved review may be a DIFFERENT human, so the person arm must
--   NOT act on its link. Both the inbound resolution AND the candidate sibling are
--   gated by is_guest_split_frozen(): a frozen inbound guest resolves v_person_id to
--   NULL (per-key create, never merged onto the other human's invoice), and a sibling
--   invoice addressed to a frozen guest is excluded from the person match. Without
--   this, a frozen guest's create would dedup onto the other human's invoice and
--   auto-create-invoice's syncDedupedInvoiceToPaid could flip that invoice to paid
--   while the guest is silently never billed.
--
-- FAM-02 PURE-PROFILE ARM (external audit follow-up P1, folded in): freezing
--   v_person_id to NULL is NOT sufficient for a DUAL-KEYED payload (player_id AND
--   guest_player_id both set — a real shape: auto-create-invoice passes both from
--   bookings[0]). Such a row belongs to the GUEST person, but P1-6's profile arm
--   (v_player_id IS NOT NULL AND i.player_id = v_player_id) is pre-FAM-02 and would
--   still dedup a frozen dual-key create onto the profile invoice (and a pure-profile
--   create onto a frozen dual-key invoice) — reopening the SAME money bug for dual-key
--   rows. The profile arm is now PURE profile on both sides (v_guest_player_id IS NULL
--   AND i.guest_player_id IS NULL); dual-key recipients dedup only via the guest-first,
--   freeze-aware person arm. (Same pure-profile-guard lesson as 3.1 r3 / 3.3-attendance.)
--
-- CONGRUENT DEGRADATION: an unlinked / pre-backfill recipient resolves v_person_id
--   to NULL, the lock key falls back to the exact pre-3.4 per-key string, and the
--   person arm is inert (v_person_id IS NOT NULL is false) — behaviour is
--   byte-identical to P1-6. A split-frozen guest ALSO resolves to NULL, so it too
--   degrades to the exact pre-3.4 per-key create. An unstamped existing invoice
--   (person_id NULL) is still caught by the retained per-key arms. Never weaker than
--   today — in ANY case (unlinked, frozen, or unstamped).
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
  --
  -- SPLIT-FREEZE (mandatory on EVERY person arm, per the 3.1+ doctrine): while a
  -- twin_detached_needs_split / merged_guest_email_moved review is pending, the
  -- guest's person link may describe a DIFFERENT human, so nothing may act on it —
  -- the guest keys as its OWN person. If the inbound guest is frozen we resolve
  -- v_person_id to NULL, collapsing the lock + recheck back to the exact pre-3.4
  -- per-key behaviour (a per-key invoice, never merged onto the sibling person's
  -- invoice). Without this the person arm would dedup a frozen guest's create onto
  -- the other human's invoice and auto-create-invoice's syncDedupedInvoiceToPaid
  -- could flip that human's invoice to paid, while the guest is never billed.
  -- is_guest_split_frozen(NULL) is false, so a pure-profile recipient is unaffected.
  v_person_id := CASE
    WHEN public.is_guest_split_frozen(v_guest_player_id) THEN NULL
    ELSE COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = v_guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = v_player_id)
    )
  END;

  -- Person-keyed lock (falls back to the old per-key string when unlinked) so that
  -- cross-key concurrent creates for ONE person serialize on the same lock.
  v_recipient_key := v_trainer_id::text || ':' ||
    COALESCE(v_person_id::text, v_player_id::text, v_guest_player_id::text, 'none');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_recipient_key, 0));
  IF array_length(v_booking_ids, 1) > 0 THEN
    SELECT i.* INTO v_winner FROM public.invoices i
    WHERE i.trainer_id = v_trainer_id AND i.status <> 'cancelled' AND i.booking_ids && v_booking_ids
      -- FAM-02 pure-profile arm: a dual-keyed row (player_id AND guest_player_id both
      -- set) belongs to the GUEST person, so the profile arm must be PURE profile on
      -- BOTH the inbound payload and the candidate row (AND ... guest_player_id IS
      -- NULL). Without the guard, a frozen dual-key create dedups onto a profile
      -- invoice (and vice-versa) via this arm even though v_person_id was frozen to
      -- NULL — the same syncDedupedInvoiceToPaid money bug as the guest-only case,
      -- just carried forward from P1-6's pre-FAM-02 predicate. Dual-key recipients
      -- dedup only via the (guest-first, freeze-aware) person arm below.
      AND ((v_player_id IS NOT NULL AND v_guest_player_id IS NULL
              AND i.player_id = v_player_id AND i.guest_player_id IS NULL)
        -- FAM-02 guest arm: fires whenever the inbound has a guest ref (guest-only OR
        -- dual-key — the guest is the recipient in both), matching any invoice on the
        -- same guest key. This keeps the pre-3.4 double-bill guard alive for a frozen
        -- dual-key recipient (which no longer uses the pure-profile arm and whose person
        -- arm is frozen-inert): its repeat/concurrent create still dedups onto its own
        -- prior invoice via the guest key. (Was `v_player_id IS NULL AND ...`, which
        -- wrongly excluded dual-key inbound.)
        OR (v_guest_player_id IS NOT NULL AND i.guest_player_id = v_guest_player_id)
        -- Phase 3.4: sibling under the person's OTHER key, same bookings. Freeze
        -- applies to the candidate ROW too (not just the caller): a sibling invoice
        -- addressed to a split-frozen guest may belong to a DIFFERENT human, so it
        -- is excluded from the person match. is_guest_split_frozen(NULL) is false, so
        -- a profile-addressed sibling still matches.
        OR (v_person_id IS NOT NULL AND i.person_id = v_person_id
            AND NOT public.is_guest_split_frozen(i.guest_player_id)))
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
  'P1-6 + Phase 3.4: atomic per-(trainer,PERSON) invoice create. Advisory-locked overlap dedup + insert in one txn; the lock + overlap recheck are person-keyed (guest-first via person_links) so a merged person cannot be double-billed across their profile/guest keys, degrading to per-key when unlinked. SERVICE-ROLE ONLY: the edge fn auto-create-invoice is the authorization boundary (validates admin / slot trainer / academy manager, else 403) and then calls this with the service-role client; no client/authenticated caller may invoke it directly.';

-- SECURITY (Phase 3.4, audit P1): this SECURITY DEFINER function INSERTs into
-- invoices with NO internal caller-ownership check — auto-create-invoice is the
-- authorization boundary (admin / the slot's trainer / the academy manager, else
-- 403) and only THEN calls this RPC. requireUser() (_shared/auth.ts) hands EVERY
-- caller a service-role client, so the sole caller does NOT need (and never used)
-- the `authenticated` grant. The pre-3.4 grant to `authenticated` let ANY logged-in
-- user call this RPC directly via PostgREST and mint an arbitrary invoice (any
-- trainer_id / amount / status), bypassing those checks — a money-path IDOR. Lock
-- it to service_role only (mirrors the can_book_member_window service-role lock).
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.create_invoice_deduped(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_invoice_deduped(jsonb) TO service_role;
