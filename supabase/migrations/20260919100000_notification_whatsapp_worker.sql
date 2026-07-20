-- Notification Foundation v2 — PR 9: the WhatsApp worker's server-side halves.
--
-- Two things the worker and the Twilio webhook cannot do safely in TypeScript:
--
--   * whatsapp_consent_active     — the SEND-TIME consent re-check. The resolver checks
--     consent at ENQUEUE, but a STOP can arrive in the gap before the worker drains the row,
--     and messaging someone after they said stop is precisely what drives the quality rating
--     down and gets the sender DISABLED. Same shape as the email worker's is_email_suppressed
--     re-check, opposite polarity: email asks "is this blocked?", WhatsApp asks "is this still
--     allowed?" — because for WhatsApp, absence of an answer must mean NO.
--
--   * record_whatsapp_status_event — a Twilio status callback knows only the Message SID, so
--     the outbox correlation and the delivery-log write belong server-side.

-- ---------------------------------------------------------------------------
-- 1. Send-time consent re-check.
--
-- Keyed on the NUMBER, not the tenant: the resolver already proved tenant scope at enqueue,
-- and a STOP addresses the sender, so the only question left is "has this number since said
-- stop?". FAILS CLOSED twice over — normalize_phone_e164 returns NULL for junk (and `= NULL`
-- makes EXISTS false), and a number with no contact row at all is not consented.
--
-- Deliberately NOT "no revoked row exists for this number": a RECYCLED number legitimately
-- carries the previous owner's retired (opted_out) row alongside the new owner's opted_in one,
-- and the stricter rule would refuse that number forever. A real STOP revokes EVERY row for
-- the number, so nothing grants after one — which is the property that actually matters.
CREATE OR REPLACE FUNCTION public.whatsapp_consent_active(p_phone text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.notification_contacts c
    WHERE c.channel = 'whatsapp'
      AND c.destination_normalized = public.normalize_phone_e164(p_phone)
      AND c.consent_status = 'opted_in'
      AND c.revoked_at IS NULL
  );
$$;
COMMENT ON FUNCTION public.whatsapp_consent_active(text) IS
  'Notification v2 (PR 9): TRUE iff the number still has an opted-in, non-revoked WhatsApp contact. The worker''s send-time re-check — consent can be withdrawn between enqueue and send. Fails closed (unnormalizable or unknown number => false). service_role only.';
REVOKE ALL ON FUNCTION public.whatsapp_consent_active(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_consent_active(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Record a Twilio message-status callback on the delivery log.
--
-- Statuses are mapped onto the EXISTING event_type CHECK values rather than widening the
-- taxonomy: PR 7's timeline UI renders that set, and the raw Twilio status + error code are
-- preserved in `reason`, so the mapping loses nothing that a reader needs.
--
-- invoice_id is deliberately left NULL. get_invoice_delivery_status() correlates by
-- invoice_id, so populating it would make a WhatsApp failure render as an INVOICE EMAIL
-- delivery issue on three surfaces — a different channel's problem wearing email's badge.
CREATE OR REPLACE FUNCTION public.record_whatsapp_status_event(
  p_message_sid   text,
  p_status        text,
  p_error_code    text DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_outbox_id   uuid;
  v_redacted    text;
  v_event       text;
  v_inserted    int;
BEGIN
  IF p_message_sid IS NULL OR btrim(p_message_sid) = '' OR p_status IS NULL THEN
    RETURN 'ignored';
  END IF;

  v_event := CASE lower(btrim(p_status))
    WHEN 'accepted'    THEN 'sent'
    WHEN 'queued'      THEN 'sent'
    WHEN 'sending'     THEN 'sent'
    WHEN 'sent'        THEN 'sent'
    WHEN 'delivered'   THEN 'delivered'
    WHEN 'read'        THEN 'delivered'   -- read implies delivered; the raw status lands in reason
    WHEN 'failed'      THEN 'failed'
    WHEN 'undelivered' THEN 'bounced'     -- the WhatsApp analogue of a bounce
    ELSE NULL
  END;
  IF v_event IS NULL THEN
    RETURN 'ignored';                     -- an unknown status is not silently coerced
  END IF;

  SELECT o.id, o.destination_redacted
    INTO v_outbox_id, v_redacted
  FROM public.notification_outbox o
  WHERE o.provider_message_id = p_message_sid
    AND o.channel = 'whatsapp'
  LIMIT 1;

  -- resend_event_id carries a UNIQUE partial index, so reusing it as the PROVIDER event id
  -- gives webhook-retry idempotency for free: Twilio re-delivers callbacks, and the same
  -- (sid, status) pair must not double-log.
  INSERT INTO public.email_delivery_events
    (channel, outbox_id, event_type, resend_event_id, resend_email_id,
     recipient_email, destination_redacted, reason, occurred_at)
  VALUES
    ('whatsapp', v_outbox_id, v_event,
     'twilio:' || p_message_sid || ':' || lower(btrim(p_status)),
     p_message_sid,
     NULL,                                -- a phone can never live in recipient_email
     v_redacted,
     nullif(btrim(concat_ws(' ', lower(btrim(p_status)), p_error_code, p_error_message)), ''),
     now())
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN 'duplicate';
  END IF;
  RETURN CASE WHEN v_outbox_id IS NULL THEN 'unmatched' ELSE 'recorded' END;
END;
$$;
COMMENT ON FUNCTION public.record_whatsapp_status_event(text, text, text, text) IS
  'Notification v2 (PR 9): log a Twilio WhatsApp message-status callback on email_delivery_events (channel=whatsapp), correlated to the outbox row by provider_message_id. Idempotent on (sid, status) via resend_event_id. Returns recorded|duplicate|unmatched|ignored. service_role only.';
REVOKE ALL ON FUNCTION public.record_whatsapp_status_event(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_status_event(text, text, text, text) TO service_role;
