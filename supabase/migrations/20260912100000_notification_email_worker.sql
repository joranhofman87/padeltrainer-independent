-- Notification Foundation v2 — PR 4: the email-worker data layer.
-- See docs/NOTIFICATION_ARCHITECTURE.md §2 (worker) + §6 item 4.
--
-- The worker edge function (supabase/functions/notification-email-worker) is a
-- cron-driven drainer: it CLAIMS a batch of due email rows, sends each via Resend,
-- and RECORDS the outcome. All the atomicity/idempotency/backoff policy lives in
-- these SECURITY DEFINER RPCs so the edge function stays a thin send loop:
--   * claim_notification_outbox_batch  — atomic claim (FOR UPDATE SKIP LOCKED) so
--     concurrent/overlapping cron runs never double-send the same row.
--   * record_notification_send_result  — mark sent, or retry with exponential
--     backoff up to max_attempts then fail; write the delivery event either way.
--   * claim_skipped_required_alerts     — the PR-3 hand-off: the resolver writes the
--     durable 'skipped' row, the WORKER raises the ops Slack alert (SQL can't do
--     outbound HTTP). ops_alerted_at makes that alert exactly-once.

-- exactly-once ops alerting for skipped-required rows
ALTER TABLE public.notification_outbox ADD COLUMN IF NOT EXISTS ops_alerted_at timestamptz;
-- partial index for the (small, transient) skipped-required-unalerted scan
CREATE INDEX IF NOT EXISTS idx_notification_outbox_skipped_unalerted
  ON public.notification_outbox (created_at)
  WHERE status = 'skipped' AND ops_alerted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1. claim a batch of due rows for one channel — atomic + concurrency-safe.
CREATE OR REPLACE FUNCTION public.claim_notification_outbox_batch(
  p_channel text,
  p_worker  text,
  p_limit   int DEFAULT 20
) RETURNS TABLE (
  outbox_id              uuid,
  event_type             text,
  template_key           text,
  destination_normalized text,
  destination_redacted   text,
  payload                jsonb,
  attempts               int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
-- RETURNS TABLE OUT names (status/attempts/...) would shadow columns; every real
-- reference here is table-qualified or p_-prefixed, so prefer the column always.
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    WHERE o.channel = p_channel
      AND o.status = 'pending'
      AND o.scheduled_for <= now()
      AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
    ORDER BY o.scheduled_for
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(p_limit, 0)
  )
  UPDATE public.notification_outbox o
  SET status          = 'processing',
      locked_at       = now(),
      locked_by       = p_worker,
      attempts        = o.attempts + 1,   -- claim == an attempt; RETURNING sees the new count
      next_attempt_at = NULL,
      updated_at      = now()
  FROM due
  WHERE o.id = due.id
  RETURNING o.id, o.event_type, o.template_key, o.destination_normalized,
            o.destination_redacted, o.payload, o.attempts;
END;
$$;
COMMENT ON FUNCTION public.claim_notification_outbox_batch(text, text, int) IS
  'Notification v2 worker: atomically claim (FOR UPDATE SKIP LOCKED) a batch of due, pending rows for one channel, mark them processing + increment attempts, and return the send payload. service_role only.';
REVOKE ALL ON FUNCTION public.claim_notification_outbox_batch(text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_batch(text, text, int) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. record the send outcome: sent, or retry-with-backoff → fail; + delivery event.
CREATE OR REPLACE FUNCTION public.record_notification_send_result(
  p_outbox_id           uuid,
  p_status              text,               -- 'sent' | 'failed'
  p_provider_message_id text DEFAULT NULL,
  p_error               text DEFAULT NULL,
  p_provider            text DEFAULT 'resend',
  p_max_backoff_minutes int  DEFAULT 60,
  p_terminal            boolean DEFAULT false  -- true = don't retry (suppressed / non-retryable / bad payload)
) RETURNS text                              -- the resulting outbox status
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

  -- normalized email only for the email channel (a phone can't live in recipient_email)
  v_email := CASE WHEN v_row.channel = 'email' THEN lower(btrim(v_row.destination_normalized)) ELSE NULL END;

  IF p_status = 'sent' THEN
    v_new_status := 'sent';
    UPDATE public.notification_outbox
    SET status = 'sent', sent_at = now(), provider = p_provider,
        provider_message_id = p_provider_message_id, last_error = NULL,
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
          locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = p_outbox_id;
    ELSE
      v_new_status := 'pending';  -- exponential backoff (2^attempts min, capped), re-queued
      UPDATE public.notification_outbox
      SET status = 'pending',
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
COMMENT ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, int, boolean) IS
  'Notification v2 worker: record a send outcome — sent (final) or failed (retry with exponential backoff up to max_attempts, or terminal when p_terminal), and log the delivery event on email_delivery_events. Returns the new outbox status. service_role only.';
REVOKE ALL ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, int, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. claim skipped-required rows for a one-time ops Slack alert (PR-3 hand-off).
CREATE OR REPLACE FUNCTION public.claim_skipped_required_alerts(
  p_limit int DEFAULT 20
) RETURNS TABLE (
  outbox_id           uuid,
  event_type          text,
  skip_reason         text,
  related_invoice_id  uuid,
  related_booking_ids uuid[],
  created_at          timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    JOIN public.notification_event_types e ON e.key = o.event_type
    WHERE o.status = 'skipped'
      AND o.ops_alerted_at IS NULL
      AND e.required_delivery
    ORDER BY o.created_at
    FOR UPDATE OF o SKIP LOCKED
    LIMIT greatest(p_limit, 0)
  )
  UPDATE public.notification_outbox o
  SET ops_alerted_at = now(), updated_at = now()
  FROM due
  WHERE o.id = due.id
  -- NB: returns SAFE refs only (no destination/payload) — the ops alert must not carry PII.
  RETURNING o.id, o.event_type, o.skip_reason, o.related_invoice_id, o.related_booking_ids, o.created_at;
END;
$$;
COMMENT ON FUNCTION public.claim_skipped_required_alerts(int) IS
  'Notification v2 worker: atomically claim skipped rows for REQUIRED events not yet ops-alerted (sets ops_alerted_at → exactly-once), returning SAFE refs only for a Slack alert. service_role only.';
REVOKE ALL ON FUNCTION public.claim_skipped_required_alerts(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_skipped_required_alerts(int) TO service_role;
