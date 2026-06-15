-- Email delivery tracking — Phase 5 remediation foundation.
--
-- Two ways an academy fixes a bouncing email (guests are edited inline elsewhere):
--   * billing-email OVERRIDE: an invoice-only address per (academy, player) that
--     never touches the player's login. Stored on academy_player_metadata and
--     applied FIRST in get_invoice_recipient_identity.
--   * DIRECT edit of the real email: only when safe — gated by
--     get_player_email_edit_capability (never-logged-in + single-tenant + owned).
--     The actual write happens in the update-user edge fn (auth.admin); this RPC
--     just tells the UI which path to offer.

-- 1) the override column (academy-scoped; existing manager RLS on the table covers it)
ALTER TABLE public.academy_player_metadata ADD COLUMN IF NOT EXISTS billing_email text;

-- 2) resolver gains an academy-scoped billing-email override (top precedence for the
--    email only). Adding a param changes the signature, so drop + recreate; the
--    2-arg call sites resolve to this 3-arg version (override skipped when academy NULL).
DROP FUNCTION IF EXISTS public.get_invoice_recipient_identity(uuid, uuid);

CREATE FUNCTION public.get_invoice_recipient_identity(
  _player_id uuid DEFAULT NULL,
  _guest_player_id uuid DEFAULT NULL,
  _academy_profile_id uuid DEFAULT NULL
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
  -- Registered player: the profile is identity + billing; billing_email override wins for email.
  SELECT
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Unknown Player'),
    COALESCE(
      (SELECT NULLIF(btrim(m.billing_email), '')
         FROM public.academy_player_metadata m
        WHERE m.academy_profile_id = _academy_profile_id AND m.removed_at IS NULL
          AND m.profile_id = _player_id
        LIMIT 1),
      p.email, ''),
    COALESCE(p.phone, ''),
    p.billing_business_name,
    p.billing_address,
    p.billing_btw_number
  FROM public.profiles p
  WHERE _player_id IS NOT NULL AND p.id = _player_id

  UNION ALL

  -- Guest: own name first; contact + billing from the linked profile first; override wins for email.
  SELECT
    COALESCE(
      NULLIF(btrim(COALESCE(g.first_name, '') || ' ' || COALESCE(g.last_name, '')), ''),
      NULLIF(btrim(g.full_name), ''),
      NULLIF(btrim(lp.full_name), ''),
      'Unknown Player'
    ),
    COALESCE(
      (SELECT NULLIF(btrim(m.billing_email), '')
         FROM public.academy_player_metadata m
        WHERE m.academy_profile_id = _academy_profile_id AND m.removed_at IS NULL
          AND m.guest_player_id = _guest_player_id
        LIMIT 1),
      NULLIF(btrim(lp.email), ''), g.email, ''),
    COALESCE(NULLIF(btrim(lp.phone), ''), g.phone, ''),
    COALESCE(lp.billing_business_name, g.billing_business_name),
    COALESCE(lp.billing_address, g.billing_address),
    COALESCE(lp.billing_btw_number, g.billing_btw_number)
  FROM public.guest_players g
  LEFT JOIN public.profiles lp ON lp.id = g.linked_profile_id
  WHERE _player_id IS NULL AND _guest_player_id IS NOT NULL AND g.id = _guest_player_id;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_recipient_identity(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_recipient_identity(uuid, uuid, uuid) TO service_role;

-- 3) the client-safe wrapper now passes the invoice's academy so the recipient card
--    reflects the override.
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
    FROM public.get_invoice_recipient_identity(inv.player_id, inv.guest_player_id, inv.academy_profile_id);
  RETURN NULLIF(btrim(COALESCE(v_email, '')), '');
END;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_recipient_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_recipient_email(uuid) TO authenticated, service_role;

-- 4) the capability gate. Returns 'direct' ONLY when an academy may safely overwrite
--    the player's real login email: the player has NEVER logged in, is linked to no
--    org other than this academy (no other academy/trainer is affected — checked
--    across academy_player_metadata AND invoices), and this academy owns them.
--    Otherwise 'override'. Conservative by construction: anything uncertain -> override.
CREATE OR REPLACE FUNCTION public.get_player_email_edit_capability(
  _profile_id uuid,
  _academy_profile_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owned           boolean;
  v_other_orgs      integer;
  v_never_logged_in boolean;
BEGIN
  IF NOT (public.is_academy_manager(auth.uid(), _academy_profile_id) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized for academy %', _academy_profile_id USING ERRCODE = '42501';
  END IF;

  IF _profile_id IS NULL THEN
    RETURN 'override';  -- guests are edited inline, not via this gate
  END IF;

  -- this academy must actively own the player
  SELECT EXISTS (
    SELECT 1 FROM public.academy_player_metadata m
    WHERE m.profile_id = _profile_id AND m.academy_profile_id = _academy_profile_id AND m.removed_at IS NULL
  ) INTO v_owned;
  IF NOT v_owned THEN
    RETURN 'override';
  END IF;

  -- any OTHER academy/trainer linked to this player (roster or invoices)?
  SELECT count(*) INTO v_other_orgs FROM (
    SELECT 'a:' || m.academy_profile_id::text AS org FROM public.academy_player_metadata m
      WHERE m.profile_id = _profile_id AND m.removed_at IS NULL AND m.academy_profile_id IS NOT NULL
    UNION
    SELECT 't:' || m.trainer_profile_id::text FROM public.academy_player_metadata m
      WHERE m.profile_id = _profile_id AND m.removed_at IS NULL AND m.trainer_profile_id IS NOT NULL
    UNION
    SELECT 'a:' || i.academy_profile_id::text FROM public.invoices i
      WHERE i.player_id = _profile_id AND i.academy_profile_id IS NOT NULL
    UNION
    SELECT 't:' || i.trainer_id::text FROM public.invoices i
      WHERE i.player_id = _profile_id AND i.trainer_id IS NOT NULL
  ) orgs
  WHERE orgs.org <> 'a:' || _academy_profile_id::text;
  IF v_other_orgs > 0 THEN
    RETURN 'override';
  END IF;

  -- never logged in? (no auth.users row, or last_sign_in_at null -> never used as a login)
  SELECT (u.last_sign_in_at IS NULL) INTO v_never_logged_in
  FROM public.profiles pr
  JOIN auth.users u ON u.id = pr.user_id
  WHERE pr.id = _profile_id;
  IF NOT coalesce(v_never_logged_in, false) THEN
    RETURN 'override';
  END IF;

  RETURN 'direct';
END;
$$;

COMMENT ON FUNCTION public.get_player_email_edit_capability(uuid, uuid) IS
  'Email remediation: ''direct'' if the academy may overwrite the player''s real login email (never logged in + single-tenant + owned), else ''override''. SECURITY DEFINER, is_academy_manager authorized.';
REVOKE ALL ON FUNCTION public.get_player_email_edit_capability(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_email_edit_capability(uuid, uuid) TO authenticated;
