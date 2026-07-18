-- Phase 3.5a: PLAYER INVOICE VISIBILITY — the person-keyed invoice list.
--
-- PROBLEM (scout-confirmed, live prod):
--   The player invoice LIST (PlayerInvoicesTab) was delivered ONLY by a direct
--   `.eq('player_id', profileId)` select under the RLS policy "Players can view
--   their own non-draft invoices" (20260406190518) — player_id ONLY. A MERGED
--   person's guest-keyed invoices (guest_player_id set, player_id NULL) were
--   INVISIBLE to the account holder: merge moves guest_player_id only, and the
--   signup-time email linker is the sole player_id stamper. Additionally the
--   player SELECT/UPDATE arms had NO FAM-02/split-freeze handling: a both-keyed
--   invoice whose guest is split-pending (may be a DIFFERENT human) stayed
--   visible AND billing-editable to the profile holder.
--
-- FIX = converge on the Phase-3.1-r3 BOOKINGS template (the audited pattern):
--   (1) NEW SECURITY DEFINER reader get_my_invoices() — person-keyed, mirroring
--       get_my_paid_booking_ids (20260826290000) VERBATIM in structure: player
--       arm OR person arm OR twin/linked-guest bridge, with the split-pending
--       freeze applied OUTSIDE the arms (a frozen guest's rows are withheld
--       entirely — identity uncertain). Non-draft only. Adds can_edit_billing
--       (true only for PURE-PROFILE rows — see (3)).
--   (2) RLS SELECT policy becomes PURE-PROFILE (player_id = me AND
--       guest_player_id IS NULL): FAM-02 — a dual-keyed row belongs to the
--       GUEST person; every guest-side/merged/bridged row reaches the player
--       exclusively through the frozen DEFINER reader. Same shape as the four
--       bookings player policies (20260826290000).
--   (3) RLS UPDATE policy becomes PURE-PROFILE on USING + WITH CHECK: closes
--       the billing-edit half of the freeze risk (a player can no longer
--       mutate a guest-owned/both-keyed invoice's billing fields at all). The
--       protect_invoice_financial_columns_for_players trigger (20260530120000)
--       needs NO change: it engages on NEW.player_id = me, and pure-profile is
--       now the only player-updatable shape, which that predicate covers.
--
-- CONGRUENT DEGRADATION: the client tries the RPC and falls back to the old
--   direct pure-profile select on error, so a Vercel deploy ahead of db push
--   behaves like today. Unmerged persons see exactly what they saw before
--   (player arm unchanged); merged persons GAIN their guest-keyed invoices.

-- ---------------------------------------------------------------------------
-- 1) get_my_invoices — the person-keyed player invoice list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_invoices()
RETURNS TABLE (
  id uuid,
  invoice_number text,
  invoice_date date,
  due_date date,
  player_name text,
  player_business_name text,
  player_address text,
  player_btw_number text,
  subtotal numeric,
  vat_rate numeric,
  vat_amount numeric,
  total numeric,
  status text,
  pdf_url text,
  sent_at timestamptz,
  paid_at timestamptz,
  notes text,
  can_edit_billing boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
  v_person uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;  -- not a known player → no rows
  END IF;
  v_person := public.get_my_person_id();

  RETURN QUERY
  SELECT
    i.id, i.invoice_number, i.invoice_date, i.due_date,
    i.player_name, i.player_business_name, i.player_address, i.player_btw_number,
    i.subtotal, i.vat_rate, i.vat_amount, i.total,
    i.status, i.pdf_url, i.sent_at, i.paid_at, i.notes,
    -- Billing edit stays PURE-PROFILE only (matches the UPDATE policy below):
    -- a guest-keyed/both-keyed invoice belongs to the guest person (FAM-02) and
    -- its billing identity is managed by the trainer/academy side.
    (i.player_id = v_profile AND i.guest_player_id IS NULL) AS can_edit_billing
  FROM public.invoices i
  WHERE i.status != 'draft'
    -- split-pending freeze OUTSIDE the arms (see get_my_linked_guest_bookings /
    -- get_my_paid_booking_ids, 20260826290000). Applies to the player arm too: a
    -- both-keyed invoice's player_id was added by the email linker (inference),
    -- so while its guest is split-pending the whole row is withheld.
    AND (i.guest_player_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.person_merge_review r
      WHERE r.guest_player_id = i.guest_player_id AND r.status = 'pending'
        AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')))
    AND (
      i.player_id = v_profile
      OR (v_person IS NOT NULL AND i.person_id = v_person)
      OR i.guest_player_id IN (
        SELECT gp.id FROM public.guest_players gp
        WHERE gp.twin_of_profile_id = v_profile
           OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = v_profile)
      )
    )
  ORDER BY i.invoice_date DESC;
END;
$$;

COMMENT ON FUNCTION public.get_my_invoices() IS
  'Phase 3.5a: the player invoice LIST, person-keyed. Player arm + person arm + twin/linked-guest bridge with the split-pending freeze OUTSIDE the arms (mirrors get_my_paid_booking_ids). Non-draft only; can_edit_billing = pure-profile rows only. Replaces the direct player_id select in PlayerInvoicesTab.';

REVOKE ALL ON FUNCTION public.get_my_invoices() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_invoices() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_invoices() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) SELECT policy → pure-profile (FAM-02; guest-side rows flow via the reader)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Players can view their own non-draft invoices" ON public.invoices;
CREATE POLICY "Players can view their own non-draft invoices"
ON public.invoices
FOR SELECT
TO authenticated
USING (
  player_id = public.get_profile_id_for_user(auth.uid())
  AND guest_player_id IS NULL
  AND status != 'draft'
);

-- ---------------------------------------------------------------------------
-- 3) UPDATE policy → pure-profile on USING + WITH CHECK
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Players can update billing details on their own invoices" ON public.invoices;
CREATE POLICY "Players can update billing details on their own invoices"
ON public.invoices
FOR UPDATE
USING (
  player_id IS NOT NULL
  AND player_id = (SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid())
  AND guest_player_id IS NULL
)
WITH CHECK (
  player_id IS NOT NULL
  AND player_id = (SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid())
  AND guest_player_id IS NULL
);
