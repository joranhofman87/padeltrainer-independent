-- D-10: a linked guest's contact/billing diverged between surfaces. The player
-- UI resolves identity profile-first (get_players_overview), but the invoice
-- edge functions read the raw guest_players row — so after a parent edits their
-- contact/billing in EditProfile, invoices still snapshot/send to the stale
-- guest values (wrong email, old billing).
--
-- Single source of truth: get_invoice_recipient_identity applies the FAM-02 rule
-- everywhere — the person's OWN name (a child is invoiced under their own name),
-- but contact + billing come from the linked profile first (a family shares one
-- email/billing), falling back to the guest row. service_role only (the edge
-- functions); NOT exposed to clients (it would leak any profile's email/billing).

CREATE OR REPLACE FUNCTION public.get_invoice_recipient_identity(
  _player_id uuid DEFAULT NULL,
  _guest_player_id uuid DEFAULT NULL
)
RETURNS TABLE (
  full_name text,
  email text,
  phone text,
  billing_business_name text,
  billing_address text,
  billing_btw_number text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Registered player: the profile is identity + billing.
  SELECT
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Unknown Player'),
    COALESCE(p.email, ''),
    COALESCE(p.phone, ''),
    p.billing_business_name,
    p.billing_address,
    p.billing_btw_number
  FROM public.profiles p
  WHERE _player_id IS NOT NULL AND p.id = _player_id

  UNION ALL

  -- Guest: own name first; contact + billing from the linked profile first.
  SELECT
    COALESCE(
      NULLIF(btrim(COALESCE(g.first_name, '') || ' ' || COALESCE(g.last_name, '')), ''),
      NULLIF(btrim(g.full_name), ''),
      NULLIF(btrim(lp.full_name), ''),
      'Unknown Player'
    ),
    COALESCE(NULLIF(btrim(lp.email), ''), g.email, ''),
    COALESCE(NULLIF(btrim(lp.phone), ''), g.phone, ''),
    COALESCE(lp.billing_business_name, g.billing_business_name),
    COALESCE(lp.billing_address, g.billing_address),
    COALESCE(lp.billing_btw_number, g.billing_btw_number)
  FROM public.guest_players g
  LEFT JOIN public.profiles lp ON lp.id = g.linked_profile_id
  WHERE _player_id IS NULL AND _guest_player_id IS NOT NULL AND g.id = _guest_player_id;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_recipient_identity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_recipient_identity(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_recipient_identity(uuid, uuid) TO service_role;

-- Client-safe wrapper for the invoice recipient card: keyed by INVOICE id and
-- gated on invoice ownership, so an academy/trainer sees the correct (resolved)
-- recipient email for their own invoice without being able to probe arbitrary
-- people's emails.
CREATE OR REPLACE FUNCTION public.get_invoice_recipient_email(_invoice_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv RECORD;
  v_email text;
BEGIN
  SELECT player_id, guest_player_id, trainer_id, academy_profile_id
    INTO inv
    FROM public.invoices
   WHERE id = _invoice_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Only the owning trainer / academy manager / admin may resolve it.
  IF NOT (
    inv.trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
    OR inv.academy_profile_id IN (
      SELECT academy_profile_id FROM public.academy_managers WHERE user_id = auth.uid()
    )
    OR public.is_admin(auth.uid())
  ) THEN
    RETURN NULL;
  END IF;

  SELECT email INTO v_email
    FROM public.get_invoice_recipient_identity(inv.player_id, inv.guest_player_id);
  RETURN NULLIF(btrim(COALESCE(v_email, '')), '');
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_recipient_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_recipient_email(uuid) TO authenticated, service_role;
