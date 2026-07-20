-- Notification Foundation v2 — PR 9: self-service WhatsApp consent surface.
--
-- notification_contacts is service-role-only (RLS on, no authenticated grant) precisely so
-- "does arbitrary number X have consent?" is not a client question. But a person must be able
-- to see and withdraw their OWN consent, so these two auth-bound RPCs expose exactly that and
-- nothing more.

-- ---------------------------------------------------------------------------
-- 1. Read the CALLER'S own WhatsApp consent state.
--
-- Returns the REDACTED destination only — never the raw number. The same rule the PR 7
-- timelines follow: the person already knows their number, so showing it buys nothing, while
-- returning it makes this RPC a place where a raw destination can leak.
--
-- Always yields exactly one row so the client has no "no rows" branch to get wrong; a person
-- with no contact (or no persons row at all) gets opted_in = false.
CREATE OR REPLACE FUNCTION public.get_my_whatsapp_consent()
RETURNS TABLE (
  opted_in             boolean,
  destination_redacted text,
  consent_at           timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    c.id IS NOT NULL AS opted_in,
    c.destination_redacted,
    c.consent_at
  FROM (SELECT public.get_my_person_id() AS person_id) me
  LEFT JOIN LATERAL (
    SELECT nc.id, nc.destination_redacted, nc.consent_at
    FROM public.notification_contacts nc
    WHERE nc.person_id = me.person_id
      AND nc.channel = 'whatsapp'
      AND nc.consent_status = 'opted_in'
      AND nc.revoked_at IS NULL
    ORDER BY nc.is_primary DESC, nc.consent_at DESC NULLS LAST
    LIMIT 1
  ) c ON true
  WHERE auth.uid() IS NOT NULL;   -- anon gets no row rather than a "false" they could cache
$$;
COMMENT ON FUNCTION public.get_my_whatsapp_consent() IS
  'Notification v2 (PR 9): the CALLER''s own WhatsApp consent state for the settings page. Redacted destination only — never the raw number. Auth-bound via get_my_person_id(); one row always, opted_in=false when there is no active contact.';
REVOKE ALL ON FUNCTION public.get_my_whatsapp_consent() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_whatsapp_consent() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Withdraw the CALLER'S own WhatsApp consent.
--
-- PERSON-SCOPED, deliberately NOT number-scoped — the opposite choice from
-- record_whatsapp_optout, and for a reason. A STOP reply comes from a HANDSET and addresses
-- the sender, so it revokes every consent on that number. A settings toggle is one PERSON
-- saying "not me": revoking by number would also silence a partner or family member who
-- registered the same shared phone and never asked for anything.
--
-- Preferences are left ALONE. The two-gate rule (an opted-in contact AND a non-off cadence)
-- means dropping the contact already stops every WhatsApp send; wiping the per-event cadences
-- as well would silently discard choices the person would have to rebuild if they ever opt
-- back in.
CREATE OR REPLACE FUNCTION public.revoke_my_whatsapp_consent()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_person uuid := public.get_my_person_id();
  v_count  int;
BEGIN
  -- IS NULL, not NOT(...): a null person must not fall through into an unfiltered UPDATE.
  IF auth.uid() IS NULL OR v_person IS NULL THEN
    RAISE EXCEPTION 'not authorized to revoke WhatsApp consent' USING ERRCODE = '42501';
  END IF;

  UPDATE public.notification_contacts
  SET consent_status = 'opted_out',
      is_primary     = false,
      revoked_at     = coalesce(revoked_at, now()),   -- keep the FIRST withdrawal time
      updated_at     = now()
  WHERE channel = 'whatsapp'
    AND person_id = v_person;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.revoke_my_whatsapp_consent() IS
  'Notification v2 (PR 9): the caller withdraws their OWN WhatsApp consent from the settings page. Person-scoped, not number-scoped — unlike a STOP reply, which addresses the sender from a handset and revokes every consent on that number (this must not silence a partner sharing the phone). Leaves preferences untouched: the contact gate alone stops all sends.';
REVOKE ALL ON FUNCTION public.revoke_my_whatsapp_consent() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_my_whatsapp_consent() TO authenticated, service_role;
