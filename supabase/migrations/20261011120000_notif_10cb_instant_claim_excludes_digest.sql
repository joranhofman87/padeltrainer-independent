-- 10c-b C (part 3) — the INSTANT email/whatsapp claim must never claim a DIGEST member.
--
-- THE COLLISION. Once C routes a cutover event into the digest engine, an engine-ON member is
-- written `status='pending'`, `delivery_mode='digest'`, `scheduled_for = digest_boundary_at`.
-- `claim_notification_outbox_batch` — the INSTANT worker's claim — selected due work on
-- `channel` + `status` alone (20260912100000), with no delivery-mode predicate. Materialization
-- assigns a member to a group but does NOT make it non-pending, so group membership is no
-- protection either. At the boundary the two workers therefore RACE for the same row:
--   * with the intended structured open-slots payload the instant worker terminal-fails it for
--     a missing subject/html (notification-email-worker/index.ts), destroying a digest member;
--   * a payload that happened to carry those fields would be SENT individually instead —
--     the digest silently degrading into per-event mail, which is the whole thing 10c-b exists
--     to prevent.
--
-- Production is not exposed today only because `digest_engine_enabled` ships false. But the
-- point of C is that the engine-on route is CORRECT and safely enableable, and it was not.
-- Found by review of the C diff, fixed here rather than deferred to enablement.
--
-- THE FIX. Digest rows are simply not this worker's work — they belong to the materializer and
-- the digest worker. Exclude them from every path that touches a row: the fresh-due scan, the
-- stale-reclaim scan, and the reap. `delivery_mode IS DISTINCT FROM 'digest'` is deliberate:
-- it keeps every legacy row (delivery_mode NULL) eligible exactly as before, so this is a pure
-- narrowing for digest rows and a no-op for everything else. The whatsapp worker shares this
-- RPC and gains the same protection.
--
-- Forward-only CREATE OR REPLACE; the signature is unchanged, so privileges persist. The body
-- is otherwise reproduced verbatim from 20260912100000.

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
  -- Digest members are excluded: their lifecycle is owned by the digest state machine,
  -- and terminal-failing one here would strand a group member behind this worker's rules.
  UPDATE public.notification_outbox
  SET status = 'failed', failed_at = now(), last_error = 'stuck_in_processing',
      locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE channel = p_channel
    AND status = 'processing'
    AND delivery_mode IS DISTINCT FROM 'digest'
    AND locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    WHERE o.channel = p_channel
      -- INSTANT work only. A digest member is pending until the materializer takes it, and
      -- its scheduled_for IS the digest boundary, so without this predicate every digest
      -- member becomes claimable by the instant worker the moment its boundary passes.
      AND o.delivery_mode IS DISTINCT FROM 'digest'
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

-- ===========================================================================
-- The predicate above is CORRECT but, on its own, only a residual filter.
-- `idx_notification_outbox_due` (20260910100000) is keyed (status, scheduled_for,
-- next_attempt_at) WHERE status IN ('pending','processing') — it knows nothing about
-- delivery_mode. A digest member stays `pending` from enqueue until the materializer takes it
-- (materialization assigns digest_group_id but deliberately does NOT change status), so after a
-- big daily/weekly boundary passes, a large backlog of DUE digest rows sits directly in that
-- index. The instant claim would then walk and discard them to fill its LIMIT: with the OR,
-- the ORDER BY and SKIP LOCKED, a bounded number of RETURNED rows does not imply a bounded
-- number of SCANNED rows.
--
-- This is an enablement-time cost, not a live one (the engine ships disabled), but it is
-- cheaper to land the instant-only partial index with the predicate it serves than to discover
-- it under load. `channel` leads because the claim always filters on it.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due_instant
  ON public.notification_outbox (channel, scheduled_for, next_attempt_at)
  WHERE status IN ('pending','processing') AND delivery_mode IS DISTINCT FROM 'digest';

COMMENT ON INDEX public.idx_notification_outbox_due_instant IS
  'Instant-worker claim path: due/reclaimable rows that are NOT digest members. Keeps a large due digest backlog out of the instant claim scan entirely rather than filtering it out row by row.';

COMMENT ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) IS
  'Notification v2 INSTANT worker: atomically claim (FOR UPDATE SKIP LOCKED) due pending rows AND reclaim stale-processing rows orphaned by a crashed worker (reaping any stuck past max_attempts), mark them processing + increment attempts under the caller''s lock token, and return the send payload. Digest members (delivery_mode=''digest'') are NEVER claimed, reclaimed or reaped here — the digest state machine owns them. service_role only.';
