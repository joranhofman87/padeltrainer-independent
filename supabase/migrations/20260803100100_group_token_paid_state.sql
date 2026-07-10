-- ============================================================================
-- REBOOK · paid-group visibility on the claim page + resume-RPC identity scope
-- ============================================================================
-- Two audit fixes (internal + external audits, cross-validated):
--
-- (1) get_rebook_group_by_token: teammates whose claims are still 'pending' saw the
--     actionable "pay for the whole group" / "just my own spot" buttons even AFTER the
--     captain's group invoice was PAID — clicking led to a bogus "couldn't start the
--     online payment" error (paid invoice ≠ startable checkout) or, worse, a stacked
--     just-my-spot payment. Surface the active group invoice's STATUS and gate
--     can_rebook_group on it not being paid, so the client can render "your group's
--     spot is already paid — {captain} will confirm the line-up" instead. An UNPAID
--     active invoice deliberately keeps can_rebook_group=true: any member may complete
--     an abandoned captain checkout (the double-pay guard re-serves the same invoice).
--     Re-emits 20260626130000's body + group_invoice_status + the paid gate.
--
-- (2) get_unpaid_rebook_invoice_by_claim_token (#447): the GROUP branch returned the
--     captain's full-price invoice for ANY member token — a teammate's claim page could
--     show "complete payment to confirm your spot" linking someone ELSE's invoice.
--     Scope the group branch to the claim holder whose identity matches the invoice
--     recipient (the captain), mirroring the single branch. Re-emits 20260802100000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_rebook_group_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_self_key text;
  v_members jsonb;
  v_paid boolean;
  v_invoice_id uuid;
  v_invoice_status text;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  v_self_key := CASE WHEN c.player_id IS NOT NULL THEN 'p:' || c.player_id::text
                     ELSE 'g:' || c.guest_player_id::text END;

  -- Has the captain already paid for their group seat? (drives can_manage_group)
  SELECT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = c.booking_id AND b.payment_status = 'paid'
  ) INTO v_paid;

  -- The single active group invoice for this group (NULL until someone pays-first).
  SELECT id, status INTO v_invoice_id, v_invoice_status FROM public.invoices
  WHERE rebook_group_id = c.rebook_group_id AND status <> 'cancelled'
  ORDER BY created_at DESC LIMIT 1;

  SELECT jsonb_agg(m ORDER BY m->>'first_name')
  INTO v_members
  FROM (
    SELECT jsonb_build_object(
      'key', CASE WHEN g.player_id IS NOT NULL THEN 'p:' || g.player_id::text
                  ELSE 'g:' || g.guest_player_id::text END,
      'first_name', COALESCE(NULLIF(p.first_name, ''), NULLIF(split_part(p.full_name, ' ', 1), ''),
                             NULLIF(gp.first_name, ''), NULLIF(split_part(gp.full_name, ' ', 1), ''), '—'),
      'status', CASE WHEN bool_or(g.status = 'claimed') THEN 'claimed'
                     WHEN bool_or(g.status = 'pending') THEN 'pending'
                     ELSE 'declined' END,
      'is_self', (CASE WHEN g.player_id IS NOT NULL THEN 'p:' || g.player_id::text
                       ELSE 'g:' || g.guest_player_id::text END) = v_self_key,
      'has_email', COALESCE(NULLIF(p.email, '') IS NOT NULL OR NULLIF(gp.email, '') IS NOT NULL, false)
    ) AS m
    FROM public.slot_priority_claims g
    LEFT JOIN public.profiles p ON p.id = g.player_id
    LEFT JOIN public.guest_players gp ON gp.id = g.guest_player_id
    WHERE g.rebook_group_id = c.rebook_group_id
    GROUP BY g.player_id, g.guest_player_id, p.first_name, p.full_name, p.email, gp.first_name, gp.full_name, gp.email
  ) sub;

  RETURN jsonb_build_object(
    'rebook_group_id', c.rebook_group_id,
    -- PAID group invoice ⇒ the court is settled: no member may start another group pay
    -- (or be shown the buttons). An UNPAID active invoice keeps this true so any member
    -- can complete an abandoned captain checkout (double-pay guard re-serves it).
    'can_rebook_group', (c.status = 'pending'
      AND (s.priority_window_ends_at IS NULL OR s.priority_window_ends_at > now())
      AND COALESCE(v_invoice_status, '') <> 'paid'),
    -- The captain paid up front → may keep managing the roster even though their claim is 'claimed'.
    'can_manage_group', (c.status = 'claimed' AND v_paid),
    'group_invoice_id', v_invoice_id,
    'group_invoice_status', v_invoice_status,
    'self_key', v_self_key,
    'slot', jsonb_build_object(
      'id', s.id, 'start_time', s.start_time, 'end_time', s.end_time,
      'cyclus_id', s.cyclus_id, 'cyclus_name', s.cyclus_name,
      'price_per_session', s.price_per_session, 'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id, 'academy_profile_id', s.academy_profile_id
    ),
    'sessions', GREATEST(1, (
      SELECT count(*) FROM public.slot_priority_claims c2
      WHERE c2.rebook_group_id = c.rebook_group_id
        AND c2.player_id IS NOT DISTINCT FROM c.player_id
        AND c2.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    )),
    'members', COALESCE(v_members, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_rebook_group_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rebook_group_by_token(text) TO anon, authenticated;

-- (2) Resume RPC: scope the GROUP branch to the invoice's own recipient (the captain).
CREATE OR REPLACE FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims%ROWTYPE;
  v_cyclus_id uuid;
  v_inv public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.rebook_group_id IS NOT NULL THEN
    -- GROUP: the captain's single invoice covers the whole group (tagged rebook_group_id) —
    -- but only the CAPTAIN (the invoice recipient) gets the resume banner. A teammate's
    -- pending claim must never render "complete payment" against someone else's invoice.
    SELECT i.* INTO v_inv FROM public.invoices i
    WHERE i.rebook_group_id = c.rebook_group_id
      AND ((c.player_id IS NOT NULL AND i.player_id = c.player_id)
        OR (c.player_id IS NULL AND c.guest_player_id IS NOT NULL AND i.guest_player_id = c.guest_player_id))
      AND i.status NOT IN ('paid', 'cancelled', 'draft')
      AND i.public_token IS NOT NULL
      AND i.public_token_revoked_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1;
  ELSE
    -- SINGLE: one active invoice per claimant+cyclus (tagged rebook_cyclus_id + the claimant
    -- identity). Match the claimant on player_id, else guest_player_id (mirrors create_invoice_deduped).
    SELECT s.cyclus_id INTO v_cyclus_id FROM public.availability_slots s WHERE s.id = c.slot_id;
    IF v_cyclus_id IS NULL THEN RETURN NULL; END IF;
    SELECT i.* INTO v_inv FROM public.invoices i
    WHERE i.rebook_cyclus_id = v_cyclus_id
      AND ((c.player_id IS NOT NULL AND i.player_id = c.player_id)
        OR (c.player_id IS NULL AND c.guest_player_id IS NOT NULL AND i.guest_player_id = c.guest_player_id))
      AND i.status NOT IN ('paid', 'cancelled', 'draft')
      AND i.public_token IS NOT NULL
      AND i.public_token_revoked_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('public_token', v_inv.public_token, 'status', v_inv.status);
END;
$$;

COMMENT ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) IS
  'Token-gated read: the ONE active UNPAID rebook invoice pay token for a claim (single: rebook_cyclus_id + claimant identity; group: rebook_group_id + the invoice''s own recipient — the captain), so the claim page can offer Continue-to-payment after a dropped checkout. Returns {public_token,status} or NULL. Read-only; anon-executable.';

REVOKE ALL ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) TO anon, authenticated;
