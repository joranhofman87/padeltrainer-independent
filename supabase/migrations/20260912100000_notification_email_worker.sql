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
--     outbound HTTP). The alert is lease-then-confirm (bounded retry): a row is
--     ops_alerted_at only after Slack confirms, so a Slack failure re-tries.

-- ops alerting for skipped-required rows: a LEASE (attempt) + a confirmed-sent marker,
-- so a Slack failure re-tries next tick instead of losing the alert (at-least-once).
ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS ops_alerted_at            timestamptz,  -- set only after Slack confirms
  ADD COLUMN IF NOT EXISTS ops_alert_attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ops_alert_last_attempt_at timestamptz;
-- partial index for the (small, transient) skipped-required-unalerted scan
CREATE INDEX IF NOT EXISTS idx_notification_outbox_skipped_unalerted
  ON public.notification_outbox (created_at)
  WHERE status = 'skipped' AND ops_alerted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1. claim a batch of due rows for one channel — atomic + concurrency-safe.
CREATE OR REPLACE FUNCTION public.claim_notification_outbox_batch(
  p_channel text,
  p_worker  text,
  p_limit   int DEFAULT 20,
  p_stale_after_minutes int DEFAULT 15   -- 'processing' longer than this = a crashed/orphaned worker
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
  -- REAP: a row wedged in 'processing' past the stale window AND out of retries is
  -- terminal — so a worker that keeps crashing on one row can't loop forever.
  UPDATE public.notification_outbox
  SET status = 'failed', failed_at = now(), last_error = 'stuck_in_processing',
      locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE channel = p_channel
    AND status = 'processing'
    AND locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    WHERE o.channel = p_channel
      AND (
        -- fresh, due work
        (o.status = 'pending'
          AND o.scheduled_for <= now()
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now()))
        -- OR orphaned in-flight work (crashed after claim, before record) — reclaim it
        OR (o.status = 'processing'
          AND o.locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
          AND o.attempts < o.max_attempts)
      )
    ORDER BY o.scheduled_for
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(p_limit, 0)
  )
  UPDATE public.notification_outbox o
  SET status          = 'processing',
      locked_at       = now(),
      locked_by       = p_worker,   -- the per-run lock token; only it may later finalize the row
      attempts        = o.attempts + 1,   -- claim == an attempt; RETURNING sees the new count
      next_attempt_at = NULL,
      updated_at      = now()
  FROM due
  WHERE o.id = due.id
  RETURNING o.id, o.event_type, o.template_key, o.destination_normalized,
            o.destination_redacted, o.payload, o.attempts;
END;
$$;
COMMENT ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) IS
  'Notification v2 worker: atomically claim (FOR UPDATE SKIP LOCKED) due pending rows AND reclaim stale-processing rows orphaned by a crashed worker (reaping any stuck past max_attempts), mark them processing + increment attempts under the caller''s lock token, and return the send payload. service_role only.';
REVOKE ALL ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. record the send outcome: sent, or retry-with-backoff → fail; + delivery event.
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
COMMENT ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) IS
  'Notification v2 worker: finalize a send outcome IF the caller still owns the lock (else returns ''stale'') — sent (final) or failed (retry with exponential backoff up to max_attempts, or terminal when p_terminal), and log the delivery event on email_delivery_events. Returns the new outbox status. service_role only.';
REVOKE ALL ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_send_result(uuid, text, text, text, text, text, int, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. LEASE skipped-required rows for the ops Slack alert (PR-3 hand-off). This does
--    NOT mark them alerted — it records an ATTEMPT (ops_alert_last_attempt_at/attempts).
--    The worker sends Slack and, only on confirmed success, calls mark_skipped_alerts_sent.
--    A Slack/env/network failure therefore re-leases next tick (at-least-once), bounded
--    by p_retry_after_minutes (spacing) and p_max_attempts (give-up cap).
CREATE OR REPLACE FUNCTION public.claim_skipped_required_alerts(
  p_limit               int DEFAULT 20,
  p_retry_after_minutes int DEFAULT 5,
  p_max_attempts        int DEFAULT 5
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
      AND o.ops_alert_attempts < greatest(p_max_attempts, 1)
      AND (o.ops_alert_last_attempt_at IS NULL
           OR o.ops_alert_last_attempt_at < now() - make_interval(mins => greatest(p_retry_after_minutes, 1)))
    ORDER BY o.created_at
    FOR UPDATE OF o SKIP LOCKED
    LIMIT greatest(p_limit, 0)
  )
  UPDATE public.notification_outbox o
  SET ops_alert_last_attempt_at = now(),
      ops_alert_attempts        = o.ops_alert_attempts + 1,
      updated_at                = now()
  FROM due
  WHERE o.id = due.id
  -- NB: returns SAFE refs only (no destination/payload) — the ops alert must not carry PII.
  RETURNING o.id, o.event_type, o.skip_reason, o.related_invoice_id, o.related_booking_ids, o.created_at;
END;
$$;
COMMENT ON FUNCTION public.claim_skipped_required_alerts(int, int, int) IS
  'Notification v2 worker: LEASE skipped rows for REQUIRED events not yet ops-alerted (bumps ops_alert_attempts / ops_alert_last_attempt_at, re-leasable after p_retry_after_minutes up to p_max_attempts), returning SAFE refs only. The worker marks them sent via mark_skipped_alerts_sent only after Slack confirms. service_role only.';
REVOKE ALL ON FUNCTION public.claim_skipped_required_alerts(int, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_skipped_required_alerts(int, int, int) TO service_role;

-- 3b. mark leased alerts as delivered — called ONLY after Slack confirms the send.
CREATE OR REPLACE FUNCTION public.mark_skipped_alerts_sent(p_ids uuid[])
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.notification_outbox
  SET ops_alerted_at = now(), updated_at = now()
  WHERE id = ANY(p_ids) AND ops_alerted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION public.mark_skipped_alerts_sent(uuid[]) IS
  'Notification v2 worker: mark leased skipped-required rows ops-alerted (ops_alerted_at) after Slack confirms delivery. service_role only.';
REVOKE ALL ON FUNCTION public.mark_skipped_alerts_sent(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_skipped_alerts_sent(uuid[]) TO service_role;
