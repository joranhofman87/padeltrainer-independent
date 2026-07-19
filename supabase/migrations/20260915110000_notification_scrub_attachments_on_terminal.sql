-- Notification Foundation v2 — PR 6a follow-up: scrub large payload attachments once a
-- row reaches a TERMINAL outcome, so the outbox does not accumulate base64 blobs forever.
--
-- PR 6a carries the paid-booking invoice PDF as a base64 attachment inside
-- notification_outbox.payload (built once at enqueue → deterministic worker retries). That
-- is fine IN FLIGHT, but a 'sent'/terminal row keeping a ~tens-to-hundreds-of-KB base64
-- string in JSONB forever is real Postgres/TOAST bloat at scale. So the moment a row is
-- SENT (delivered) or terminally FAILED (won't retry), strip payload.attachments — the send
-- already happened, the attachment is never read again. A RETRYABLE failure (backoff →
-- pending) KEEPS it, because the next attempt must re-send the same PDF.
--
-- Everything else in record_notification_send_result is byte-for-byte the deployed
-- 20260912100000 definition (ownership guard, backoff, delivery-event insert); only the two
-- TERMINAL UPDATE branches gain `payload = payload - 'attachments'`.
CREATE OR REPLACE FUNCTION public.record_notification_send_result(
  p_outbox_id           uuid,
  p_worker              text,               -- the claiming run's lock token; only it may finalize
  p_status              text,               -- 'sent' | 'failed'
  p_provider_message_id text DEFAULT NULL,
  p_error               text DEFAULT NULL,
  p_provider            text DEFAULT 'resend',
  p_max_backoff_minutes int  DEFAULT 60,
  p_terminal            boolean DEFAULT false  -- true = don't retry (suppressed / non-retryable / bad payload)
) RETURNS text                              -- the resulting outbox status ('stale' = not ours)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row        public.notification_outbox%ROWTYPE;
  v_new_status text;
  v_email      text;
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

  IF p_status = 'sent' THEN
    v_new_status := 'sent';
    UPDATE public.notification_outbox
    SET status = 'sent', sent_at = now(), provider = p_provider,
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
  'Notification v2 worker: finalize a send outcome IF the caller still owns the lock (else ''stale'') — sent (final) or failed (retry with exponential backoff up to max_attempts, or terminal when p_terminal), log the delivery event, and on a TERMINAL outcome (sent / non-retryable / exhausted) strip payload.attachments so large base64 blobs (e.g. the paid-booking invoice PDF) do not bloat the outbox. Returns the new outbox status. service_role only.';
REVOKE ALL ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) TO service_role;
