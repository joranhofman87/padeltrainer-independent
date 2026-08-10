-- SLICE A, part 1 — route identity-verification mail to a DEDICATED worker, by partitioning the
-- claim rather than by filtering in application code.
--
-- THE PROBLEM. `notification-email-worker` is live in production on `*/2 * * * *`. It claims every
-- `channel='email'` row with no event-type filter, and the instant send gate terminally fails any
-- row whose payload lacks `subject`/`html`. `identity_challenge_enqueue` writes exactly such a row
-- (payload = `{challenge_id, workflow}`), because the address and the capability are deliberately
-- NOT in the outbox. So the moment the U2 schema reaches production, every verification challenge is
-- claimed within two minutes and terminally burned: no email, and a returning visitor stuck forever
-- on "check your email".
--
-- THE SHAPE OF THE FIX. Ownership is a property of the EVENT TYPE, so it belongs in the event
-- catalogue, not in either worker's code:
--
--   `notification_event_types.dedicated_worker`  NULL  => the generic worker owns it
--                                                'x'   => only the worker calling itself 'x' owns it
--
-- and the claim takes a `p_worker_kind` that must match. This is a COMPLEMENT PARTITION, which is
-- this repo's standing rule for exactly this reason (see the invoice-visibility guardrail: partition
-- by complement, never by an allow-list). Two consequences follow mechanically:
--
--   * no row can be claimed by both workers — the predicate is an equality on one value, so the two
--     worker kinds select disjoint sets;
--   * no row becomes unclaimable — every row belongs to exactly one kind. A row whose kind has no
--     worker running sits `pending` and VISIBLE, which is a stalled queue you can see, not a burned
--     row you cannot.
--
-- THE DEPLOY-ORDER INVERSION, which is the point. `p_worker_kind` is added with `DEFAULT NULL`, and
-- the deployed worker calls this RPC with three NAMED arguments. So the already-running production
-- worker resolves to the new function, gets `p_worker_kind => NULL`, and immediately claims only
-- generic rows — WITHOUT being redeployed. The migration alone makes the live worker safe, which
-- removes the ordering hazard instead of merely documenting it. (The old 4-argument function is
-- DROPped rather than left beside the new one: two overloads differing only by a defaulted trailing
-- parameter make a 3-named-argument PostgREST call ambiguous, and an ambiguous claim is an outage.)
--
-- The partition is applied to ALL THREE statements that touch a row, not only the final claim. The
-- tenant-restriction skip and the stale reap are mutations too: a generic worker that skipped the
-- claim but still reaped identity rows as `stuck_in_processing` would burn them just as dead.

ALTER TABLE public.notification_event_types
  ADD COLUMN IF NOT EXISTS dedicated_worker text;

COMMENT ON COLUMN public.notification_event_types.dedicated_worker IS
  'Which worker kind owns this event on the instant path. NULL = the generic worker. A non-NULL value names the only worker kind permitted to claim, skip or reap it, so the two sets are disjoint by construction and a row can never be claimed twice.';

-- Identity verification is the first dedicated event: its payload deliberately carries no address
-- and no rendered body, so the generic gate can only ever fail it.
UPDATE public.notification_event_types
   SET dedicated_worker = 'identity_verify'
 WHERE key = 'identity_verification_requested';

-- ONE definition of "who owns this event", so the three statements below and both workers cannot
-- drift apart. An event type absent from the catalogue answers NULL — i.e. it stays with the generic
-- worker, exactly as it behaves today. That keeps this change a strict partition of existing
-- behaviour rather than a new way for an unknown event to become unroutable.
CREATE OR REPLACE FUNCTION public.notif_event_dedicated_worker(p_event_type text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT et.dedicated_worker
    FROM public.notification_event_types et
   WHERE et.key = p_event_type;
$$;

COMMENT ON FUNCTION public.notif_event_dedicated_worker(text) IS
  'The worker kind that owns an event on the instant path, or NULL for the generic worker. Unknown event types answer NULL so they keep their present owner.';

REVOKE ALL ON FUNCTION public.notif_event_dedicated_worker(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_event_dedicated_worker(text) TO service_role;

DROP FUNCTION IF EXISTS public.claim_notification_outbox_batch(text, text, int, int);

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_batch(
  p_channel text,
  p_worker  text,
  p_limit   int DEFAULT 20,
  p_stale_after_minutes int DEFAULT 15,
  p_worker_kind text DEFAULT NULL
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
#variable_conflict use_column
DECLARE v_boundary timestamptz; v_min_occurred timestamptz;
BEGIN
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN;
  END IF;

  v_boundary := public.notif_activation_boundary(p_channel || ':instant');
  IF v_boundary IS NULL THEN
    RETURN;
  END IF;
  v_min_occurred := public.notif_activation_min_occurred_at(p_channel || ':instant');

  UPDATE public.notification_outbox o
  SET status = 'skipped', skip_reason = 'tenant_restricted',
      locked_at = NULL, locked_by = NULL, updated_at = now()
  FROM public.academy_notification_restrictions r
  JOIN public.notification_event_types et ON et.key = r.event_type
  WHERE o.channel = p_channel
    AND (
      o.status = 'pending'
      OR (o.status = 'processing'
          AND o.locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1)))
    )
    AND o.delivery_mode IS DISTINCT FROM 'digest'
    -- the partition: this worker kind only touches its own events
    AND public.notif_event_dedicated_worker(o.event_type) IS NOT DISTINCT FROM p_worker_kind
    AND o.tenant_academy_profile_id = r.academy_profile_id
    AND o.event_type = r.event_type
    AND o.channel = r.channel
    AND r.max_frequency = 'off'
    AND NOT et.required_delivery;

  UPDATE public.notification_outbox
  SET status = 'failed', failed_at = now(), last_error = 'stuck_in_processing',
      locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE channel = p_channel
    AND status = 'processing'
    AND delivery_mode IS DISTINCT FROM 'digest'
    -- the partition, again: reaping someone else's row burns it exactly as dead as claiming it
    AND public.notif_event_dedicated_worker(event_type) IS NOT DISTINCT FROM p_worker_kind
    AND locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    WHERE o.channel = p_channel
      AND o.delivery_mode IS DISTINCT FROM 'digest'
      AND public.notif_event_dedicated_worker(o.event_type) IS NOT DISTINCT FROM p_worker_kind
      AND o.created_at >= v_boundary
      AND o.occurred_at >= v_min_occurred
      AND (
        (o.status = 'pending'
          AND o.scheduled_for <= now()
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now()))
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
      locked_by       = p_worker,
      attempts        = o.attempts + 1,
      next_attempt_at = NULL,
      updated_at      = now()
  FROM due
  WHERE o.id = due.id
  RETURNING o.id, o.event_type, o.template_key, o.destination_normalized,
            o.destination_redacted, o.payload, o.attempts;
END;
$$;

COMMENT ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int, text) IS
  'The instant worker''s atomic claim, PARTITIONED BY WORKER KIND. p_worker_kind NULL claims only events whose notification_event_types.dedicated_worker is NULL (the generic worker, and the default so an already-deployed worker is correct without redeploying); a non-NULL kind claims only its own events. The partition applies to the tenant-restriction skip and the stale reap as well as the claim, because those mutate rows too. Gates otherwise unchanged: channel KILL, N5 activation boundary, occurrence floor, cap-cancel, stale reap, then FOR UPDATE SKIP LOCKED.';

REVOKE ALL ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int, text) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The send target, which is NOT the outbox destination
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The challenge is a proof of control over ONE address: the one the visitor typed, normalized and
-- stored as `contact_normalized`. The candidate person's current notification contact is a different
-- address that merely might belong to the same human — mailing it would send a capability for
-- account A to whatever address account B happens to carry today, which is the precise failure the
-- whole verification design exists to prevent.
--
-- So the sender reads its destination from the challenge, through this function, and never from the
-- outbox row. `key_version` comes back with it so the sender signs with the generation the challenge
-- was minted under, and refuses when that generation is no longer mintable rather than silently
-- signing with a newer key the stored row was never bound to.
--
-- Deliberately returns NO capability material: the HMAC is derived in the edge function at send time
-- from a key that exists only in the function environment. Nothing here, in the outbox, or in any
-- log can be replayed into a working link.
CREATE OR REPLACE FUNCTION public.identity_challenge_send_target(p_challenge_id uuid)
RETURNS TABLE (
  contact_normalized text,
  workflow           text,
  key_version        int,
  expires_at         timestamptz,
  already_consumed   boolean,
  key_mintable       boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.contact_normalized,
         c.workflow,
         c.key_version,
         c.expires_at,
         c.consumed_at IS NOT NULL,
         c.key_version >= (SELECT s.min_mintable_version FROM public.identity_verify_key_state s)
    FROM public.identity_verification_challenges c
   WHERE c.id = p_challenge_id
     AND auth.role() = 'service_role';
$$;

COMMENT ON FUNCTION public.identity_challenge_send_target(uuid) IS
  'Service-role only. The address a verification email must go to — the challenge''s own contact_normalized, never the candidate person''s current notification contact — plus the key generation it was minted under and whether that generation may still be signed with. Returns no capability material: the HMAC is derived at send time from a key held only in the edge environment.';

REVOKE ALL ON FUNCTION public.identity_challenge_send_target(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_challenge_send_target(uuid) TO service_role;
