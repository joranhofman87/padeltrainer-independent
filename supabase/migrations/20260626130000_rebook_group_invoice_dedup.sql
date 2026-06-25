-- Group-captain rebooking: prevent DOUBLE-PAY for one group.
--
-- The upfront rebooking invitation goes to EVERY member of the group, and each can click "pay for
-- the group" (create-group-rebook-invoice). Without a guard, two members could each mint a full-
-- court-price invoice and both pay → the group is charged twice. Fix structurally: tag the group
-- invoice with its rebook_group_id and enforce AT MOST ONE active (non-cancelled) invoice per group
-- with a unique partial index. create-group-rebook-invoice checks for an existing tagged invoice
-- before minting (sequential case) and the index backstops the rare concurrent race.
--
-- Also surfaces the group invoice id from get_rebook_group_by_token so the captain's post-payment
-- "manage" step links the covered teammates onto that one paid invoice (rebook_group_manage already
-- accepts _invoice_id) → the invoice overview shows the whole group on the single paid invoice.

-- (1) Tag + the hard one-active-invoice-per-group guarantee. Existing invoices keep rebook_group_id
--     NULL and are excluded from the partial index (no backfill, no conflict on apply).
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS rebook_group_id uuid;

COMMENT ON COLUMN public.invoices.rebook_group_id IS
  'When set, this is THE single group-captain upfront invoice for that rebook_group_id (full court price). A unique partial index allows at most one active (non-cancelled) invoice per group — the double-pay guard.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_active_rebook_group
  ON public.invoices (rebook_group_id)
  WHERE rebook_group_id IS NOT NULL AND status <> 'cancelled';

-- (2) get_rebook_group_by_token — same body as 20260626110000 plus group_invoice_id (the active
--     tagged invoice, if any) so the manage step can link covered bookings onto the paid invoice.
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
  SELECT id INTO v_invoice_id FROM public.invoices
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
    'can_rebook_group', (c.status = 'pending'
      AND (s.priority_window_ends_at IS NULL OR s.priority_window_ends_at > now())),
    -- The captain paid up front → may keep managing the roster even though their claim is 'claimed'.
    'can_manage_group', (c.status = 'claimed' AND v_paid),
    'group_invoice_id', v_invoice_id,
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
