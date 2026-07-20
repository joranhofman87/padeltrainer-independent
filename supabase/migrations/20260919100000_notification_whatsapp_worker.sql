-- Notification Foundation v2 — PR 9: the WhatsApp worker's server-side halves.
--
-- Two things the worker and the Twilio webhook cannot do safely in TypeScript:
--
--   * whatsapp_outbox_consent_active — the SEND-TIME consent re-check. The resolver checks
--     consent at ENQUEUE, but a STOP can arrive in the gap before the worker drains the row,
--     and messaging someone after they said stop is precisely what drives the quality rating
--     down and gets the sender DISABLED. Same shape as the email worker's is_email_suppressed
--     re-check, opposite polarity: email asks "is this blocked?", WhatsApp asks "is this still
--     allowed?" — because for WhatsApp, absence of an answer must mean NO.
--
--   * record_whatsapp_status_event — a Twilio status callback knows only the Message SID, so
--     the outbox correlation and the delivery-log write belong server-side.

-- ---------------------------------------------------------------------------
-- 1. Send-time consent re-check, bound to THE CONTACT THAT JUSTIFIED THIS ROW.
--
-- The question that matters is NOT "is anyone consented on this number?" but "is the specific
-- consent this row was enqueued against still valid?". Those diverge, and the difference is a
-- cross-person delivery:
--
--   person A opts in with number N (contact CA) -> row R enqueued, destination N, contact_id CA
--   A opts in with a NEW number     -> record_whatsapp_optin RETIRES CA (revoked, opted_out)
--   person B (spouse / N's new holder) has their own opted-in contact CB on N
--   -> a number-keyed check answers TRUE *from B's consent*, and R — A's private
--      notification — is delivered to B's phone.
--
-- Binding to contact_id closes that, and makes recycled numbers a non-issue for free: a
-- retired contact stays retired no matter who else later registers the same digits.
--
-- FAILS CLOSED at every step: unknown row, non-whatsapp row, NULL contact_id (a row we cannot
-- tie to a consent record is a row we cannot justify sending), retired contact, or a contact
-- whose number has since been edited away from the row's destination.
CREATE OR REPLACE FUNCTION public.whatsapp_outbox_consent_active(p_outbox_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.notification_outbox o
    JOIN public.notification_contacts c ON c.id = o.contact_id
    WHERE o.id = p_outbox_id
      AND o.channel = 'whatsapp'
      AND c.channel = 'whatsapp'
      AND c.consent_status = 'opted_in'
      AND c.revoked_at IS NULL
      -- the consent must still be for the number we are about to message
      AND c.destination_normalized = o.destination_normalized
  );
$$;
COMMENT ON FUNCTION public.whatsapp_outbox_consent_active(uuid) IS
  'Notification v2 (PR 9): TRUE iff the outbox row''s OWN contact is still opted-in, non-revoked and still points at the row''s destination. The worker''s send-time re-check — consent can be withdrawn between enqueue and send. Deliberately contact-bound, not number-bound: a number-keyed check would let one person''s queued row ride a DIFFERENT person''s consent on the same number. Fails closed. service_role only.';
REVOKE ALL ON FUNCTION public.whatsapp_outbox_consent_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_outbox_consent_active(uuid) TO service_role;

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

-- ---------------------------------------------------------------------------
-- 3. Provider labelling: derive it from the CHANNEL instead of defaulting to 'resend'.
--
-- record_notification_send_result defaulted p_provider to 'resend', which was correct while
-- email was the only worker and silently wrong the moment a second channel existed — the
-- WhatsApp worker's sends would have been recorded as Resend sends. Passing p_provider from
-- every worker fixes today's bug but leaves the same trap for the push worker, so the default
-- now derives from the row's own channel. An explicit p_provider still wins.
--
-- Body is otherwise byte-for-byte the deployed 20260915110000 definition (ownership guard,
-- backoff, attachment scrub, delivery-event insert); the signature is unchanged, so no drift.
CREATE OR REPLACE FUNCTION public.record_notification_send_result(
  p_outbox_id           uuid,
  p_worker              text,               -- the claiming run's lock token; only it may finalize
  p_status              text,               -- 'sent' | 'failed'
  p_provider_message_id text DEFAULT NULL,
  p_error               text DEFAULT NULL,
  p_provider            text DEFAULT NULL,   -- NULL => derive from the row's channel
  p_max_backoff_minutes int  DEFAULT 60,
  p_terminal            boolean DEFAULT false  -- true = don't retry (suppressed / non-retryable / bad payload)
) RETURNS text                              -- the resulting outbox status ('stale' = not ours)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row        public.notification_outbox%ROWTYPE;
  v_new_status text;
  v_email      text;
  v_provider   text;
BEGIN
  SELECT * INTO v_row FROM public.notification_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_notification_send_result: outbox row % not found', p_outbox_id;
  END IF;

  -- OWNERSHIP: only the current lock holder may finalize. A row already finalized, or
  -- reclaimed as stale by a NEWER run (different lock token), must NOT be overwritten by
  -- a slow/orphaned worker — else it could undo a fresh success or double-count an outcome.
  IF v_row.status <> 'processing' OR v_row.locked_by IS DISTINCT FROM p_worker THEN
    RETURN 'stale';
  END IF;

  -- normalized email only for the email channel (a phone can't live in recipient_email)
  v_email := CASE WHEN v_row.channel = 'email' THEN lower(btrim(v_row.destination_normalized)) ELSE NULL END;

  -- PROVIDER IS A FUNCTION OF CHANNEL, so derive it rather than trusting each worker to pass
  -- it. The old DEFAULT 'resend' silently mislabeled the first non-email worker's sends, and
  -- would have done the same to the next one. An explicit p_provider still wins.
  v_provider := coalesce(p_provider, CASE v_row.channel
    WHEN 'email'    THEN 'resend'
    WHEN 'whatsapp' THEN 'twilio'
    ELSE NULL
  END);

  IF p_status = 'sent' THEN
    v_new_status := 'sent';
    UPDATE public.notification_outbox
    SET status = 'sent', sent_at = now(), provider = v_provider,
        provider_message_id = p_provider_message_id, last_error = NULL,
        payload = payload - 'attachments',   -- delivered → drop the base64 attachment blob
        locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = p_outbox_id;

    INSERT INTO public.email_delivery_events
      (channel, outbox_id, event_type, resend_email_id, recipient_email, destination_redacted, occurred_at)
    VALUES
      (v_row.channel, p_outbox_id, 'sent', p_provider_message_id, v_email, v_row.destination_redacted, now());

  ELSIF p_status = 'failed' THEN
    -- terminal when the caller says so (suppressed / non-retryable / bad payload) OR retries are exhausted
    IF p_terminal OR v_row.attempts >= v_row.max_attempts THEN
      v_new_status := 'failed';
      UPDATE public.notification_outbox
      SET status = 'failed', failed_at = now(), last_error = p_error,
          payload = payload - 'attachments',   -- won't retry → drop the base64 attachment blob
          locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = p_outbox_id;
    ELSE
      v_new_status := 'pending';  -- exponential backoff (2^attempts min, capped), re-queued
      UPDATE public.notification_outbox
      SET status = 'pending',
          -- KEEP payload.attachments: the retry must re-send the same PDF.
          next_attempt_at = now() + make_interval(mins => least(power(2, v_row.attempts)::int, greatest(p_max_backoff_minutes, 1))),
          last_error = p_error, locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = p_outbox_id;
    END IF;

    INSERT INTO public.email_delivery_events
      (channel, outbox_id, event_type, recipient_email, destination_redacted, reason, occurred_at)
    VALUES
      (v_row.channel, p_outbox_id, 'send_failed', v_email, v_row.destination_redacted, p_error, now());
  ELSE
    RAISE EXCEPTION 'record_notification_send_result: invalid status % (expected sent|failed)', p_status;
  END IF;

  RETURN v_new_status;
END;
$$;
COMMENT ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) IS
  'Notification v2 worker: finalize a send outcome IF the caller still owns the lock (else ''stale'') — sent (final) or failed (retry with exponential backoff up to max_attempts, or terminal when p_terminal), log the delivery event, and on a TERMINAL outcome strip payload.attachments. The provider label DERIVES from the row''s channel (email=>resend, whatsapp=>twilio) when not passed explicitly. Returns the new outbox status. service_role only.';
REVOKE ALL ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Give an attempt BACK when the worker never reached the provider.
--
-- claim_notification_outbox_batch increments attempts on the assumption that a claim leads to
-- an attempt. For a GLOBAL CONFIG GAP that is false, and the accounting silently discards real
-- notifications: a missing template SID or wrong Twilio credentials is recorded as a
-- "retryable" failure, but record_notification_send_result still marks the row FAILED once
-- attempts >= max_attempts. With max_attempts=5 and 2^n backoff that is ~62 minutes — so a
-- config gap that outlives one hour permanently drops every queued row, which is exactly the
-- window a credential fix or a Meta template approval does NOT fit inside.
--
-- Deferring instead: undo the claim's increment, back off, release the lock. The row waits for
-- the config to be fixed instead of being burned down by it. Reserved for conditions that are
-- NOT the row's fault and where nothing was sent — a per-row problem (bad phone, withdrawn
-- consent, no committed template) is still terminal, and a real provider attempt still counts.
CREATE OR REPLACE FUNCTION public.defer_notification_outbox_row(
  p_outbox_id     uuid,
  p_worker        text,               -- the claiming run's lock token; only it may defer
  p_reason        text DEFAULT NULL,
  p_retry_minutes int  DEFAULT 5
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.notification_outbox%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.notification_outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'defer_notification_outbox_row: outbox row % not found', p_outbox_id;
  END IF;

  -- Same ownership rule as record_notification_send_result: a slow or orphaned worker must not
  -- rewind a row a newer run has since claimed.
  IF v_row.status <> 'processing' OR v_row.locked_by IS DISTINCT FROM p_worker THEN
    RETURN 'stale';
  END IF;

  UPDATE public.notification_outbox
  SET status          = 'pending',
      attempts        = greatest(v_row.attempts - 1, 0),   -- the claim's increment, undone
      next_attempt_at = now() + make_interval(mins => greatest(p_retry_minutes, 1)),
      last_error      = p_reason,
      locked_at       = NULL,
      locked_by       = NULL,
      updated_at      = now()
  WHERE id = p_outbox_id;

  RETURN 'deferred';
END;
$$;
COMMENT ON FUNCTION public.defer_notification_outbox_row(uuid, text, text, int) IS
  'Notification v2 worker: return a claimed row to pending WITHOUT consuming an attempt, for global config gaps where the worker never reached the provider (missing template SID, missing/invalid credentials). Ownership-guarded like record_notification_send_result. Prevents a config gap outliving the retry budget from permanently failing every queued row. service_role only.';
REVOKE ALL ON FUNCTION public.defer_notification_outbox_row(uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_notification_outbox_row(uuid, text, text, int) TO service_role;
