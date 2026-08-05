-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N5 M1+M2 — THE NO-BACKLOG CONTRACT AS A RUNTIME INVARIANT
--
-- THE INVARIANT (programme contract, non-negotiable 1 and 2): historical work cannot suddenly
-- become eligible when a delivery path is activated, and only events at or after that path's
-- explicit activation boundary may enter it.
--
-- WHY IT NEEDS A RUNTIME MECHANISM, not a runbook step. Every inert path accumulates rows:
-- enqueue_notification writes whatsapp rows whenever a contact is opted in, and the whatsapp
-- worker returns on its env switch BEFORE claiming, so those rows sit pending. The digest path
-- is the same shape between engine-enable and activation. Flipping the switch would then release
-- everything at once — the flood this contract exists to make impossible. A runbook cannot
-- prevent that; the send authorities have to refuse.
--
-- ── THE MODEL ──────────────────────────────────────────────────────────────────────────────
-- A DELIVERY PATH is (channel, mode): 'email:instant', 'email:digest', 'whatsapp:instant'. Each
-- has exactly one durable row here, in one of two states:
--
--   inert   — the path has never been opened. Its send authority claims NOTHING. Fail-closed:
--             no boundary row and no active state both mean "do not send".
--   active  — opened at boundary_at. Its send authority may only take rows CREATED at or after
--             that instant. The transition is one-way and the boundary is immutable, so the
--             window can never be widened later to re-admit what it excluded.
--
-- created_at is the honest marker of when the underlying event happened: it is stamped by
-- enqueue_notification when the event was resolved and never moves — a retry, a reschedule or a
-- lease reclaim all leave it alone (scheduled_for and next_attempt_at move; created_at does not).
--
-- ── WHERE IT IS ENFORCED (every authority that turns a row into a send) ─────────────────────
--   claim_notification_outbox_batch      → <channel>:instant   (instant work, digest excluded)
--   materialize_notification_digest_groups → <channel>:digest  (candidate AND member scans, so a
--                                            pre-boundary row cannot join a post-boundary group)
-- Both refuse everything while the path is inert, and both refuse pre-boundary rows while it is
-- active. Neither mutates the ledger when refusing — the same doctrine as the kill gate.
--
-- ── THE SEEDS, and why email:instant's boundary is UNBOUNDED ────────────────────────────────
-- email:instant is LIVE and has been sending for months (its cron runs every two minutes), so
-- its boundary can only be a value that excludes NOTHING. Two weaker choices were written and
-- rejected: now() strands every row enqueued in the minutes before this migration, and
-- min(created_at) is a SNAPSHOT — an enqueue transaction that began earlier but commits after
-- this statement carries an older created_at (DEFAULT now() is transaction-start time), and its
-- mail would be permanently ineligible. There is no lock that closes that: SHARE mode delays the
-- insert, it does not move the timestamp the waiting transaction already took.
--
-- So the honest boundary for a path that was activated before this contract existed is
-- '-infinity': the row records WHEN it was opened (unbounded, i.e. before we were counting) and
-- why, and the enforcement predicate is trivially true for every row. The invariant this
-- contract exists for — that ACTIVATING a path cannot release history — is about paths opened
-- from here on, and retro-closing a running path would drop live mail rather than protect
-- anyone. Closing email:instant is what the channel KILL switch is for.
--
-- The two inert paths get their boundary from the operator at the moment they are opened, which
-- is what the enable-engine step does.
--
-- (This seed was corrected in place rather than by a later migration: the guard makes an active
-- boundary immutable — deliberately — so a follow-up could only change it by disabling the very
-- protection that makes the contract worth anything. It has never been applied outside test
-- harnesses, which rebuild the chain from scratch.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.notification_activation_boundaries (
  path         text PRIMARY KEY CHECK (path IN ('email:instant', 'email:digest', 'whatsapp:instant')),
  state        text NOT NULL DEFAULT 'inert' CHECK (state IN ('inert', 'active')),
  -- the boundary itself: rows CREATED before this instant may never enter this path
  boundary_at  timestamptz,
  activated_by uuid,                       -- auth.uid() when a UI/admin path opens it; NULL from psql
  request_id   uuid UNIQUE,                -- caller identity: an exact retry replays, never re-opens
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activation_boundary_coherent CHECK (
    (state = 'inert' AND boundary_at IS NULL AND request_id IS NULL AND reason IS NULL)
    OR (state = 'active' AND boundary_at IS NOT NULL
        AND length(btrim(coalesce(reason, ''))) BETWEEN 3 AND 500)
  )
);

COMMENT ON TABLE public.notification_activation_boundaries IS
  'N5: one row per delivery path (channel:mode). inert = its send authority claims nothing; active = it may only take rows created at or after boundary_at. The transition is one-way and boundary_at is immutable, so an activated window can never be widened to re-admit historical work.';

-- ── the OWNER-EFFECTIVE guard: ACLs stop API roles, this stops the owner too ────────────────
-- Same doctrine as the digest ledger and the invocation record: definer functions and future
-- migrations run as the owner, so the state machine must be enforced by a trigger rather than by
-- the discipline of whoever writes the next migration.
CREATE OR REPLACE FUNCTION public.notif_activation_boundary_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'notification_activation_boundaries is append-only: deleting a boundary would let a path be re-opened with a NEWER window and silently re-admit the history it excluded';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.path IS DISTINCT FROM OLD.path THEN
      RAISE EXCEPTION 'notification_activation_boundaries: path is immutable';
    END IF;
    IF OLD.state = 'active' THEN
      -- everything about an opened path is frozen. A later reason/boundary edit is exactly how
      -- an audit trail stops being one.
      IF NEW.state IS DISTINCT FROM OLD.state
         OR NEW.boundary_at IS DISTINCT FROM OLD.boundary_at
         OR NEW.request_id IS DISTINCT FROM OLD.request_id
         OR NEW.reason IS DISTINCT FROM OLD.reason
         OR NEW.activated_by IS DISTINCT FROM OLD.activated_by THEN
        RAISE EXCEPTION 'notification_activation_boundaries: % is already active since % — an activated boundary is immutable', OLD.path, OLD.boundary_at;
      END IF;
    ELSIF NEW.state <> 'active' THEN
      RAISE EXCEPTION 'notification_activation_boundaries: the only transition is inert -> active';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notif_activation_boundary_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.notification_activation_boundaries
  FOR EACH ROW EXECUTE FUNCTION public.notif_activation_boundary_guard();
CREATE TRIGGER trg_notif_activation_boundary_no_truncate
  BEFORE TRUNCATE ON public.notification_activation_boundaries
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_activation_boundary_guard();

-- ACLs: definer functions only (S1 doctrine — service_role's default ALL must be revoked)
REVOKE ALL ON public.notification_activation_boundaries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.notification_activation_boundaries TO service_role;   -- admin reads

-- ── the seeds ──────────────────────────────────────────────────────────────────────────────
-- email:instant, the live path: UNBOUNDED, because it was opened before anyone was recording
-- boundaries and no timestamp computed here can be proven not to exclude mail that is already
-- queued (see the header). The enforcement predicate then admits every row, which is exactly
-- today's behaviour — this seed changes what the system SAYS, not what it sends.
INSERT INTO public.notification_activation_boundaries (path, state, boundary_at, reason)
VALUES ('email:instant', 'active', '-infinity'::timestamptz,
        'activated before the no-backlog contract existed: the boundary is unbounded, because no computed instant can be proven not to exclude mail already queued. Use the channel kill switch to stop this path.')
ON CONFLICT (path) DO NOTHING;

-- the two paths that have never sent anything. The operator opens them, once, at rollout.
INSERT INTO public.notification_activation_boundaries (path, state)
VALUES ('email:digest', 'inert'), ('whatsapp:instant', 'inert')
ON CONFLICT (path) DO NOTHING;

-- ── the reader: one place that answers "may this path take this row?" ───────────────────────
-- STABLE and tiny (primary-key read), so calling it per authority costs nothing. NULL means the
-- path may take NOTHING — callers must treat a NULL boundary as a refusal, never as "no limit".
CREATE OR REPLACE FUNCTION public.notif_activation_boundary(p_path text)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.boundary_at FROM public.notification_activation_boundaries b
   WHERE b.path = p_path AND b.state = 'active';
$$;
COMMENT ON FUNCTION public.notif_activation_boundary(text) IS
  'N5: the instant from which a delivery path may take work, or NULL when the path is inert (which every caller must treat as "take nothing"). Read by the send authorities and by the readiness envelope.';
REVOKE ALL ON FUNCTION public.notif_activation_boundary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_activation_boundary(text) TO authenticated, service_role;

-- ── opening a path: one-way, request-id idempotent, refused if already open ─────────────────
-- Granted to service_role only. Opening a delivery path is an owner-gated runbook act performed
-- by the rollout artifacts (psql, no JWT); the admin UI READS this state and never writes it.
CREATE OR REPLACE FUNCTION public.record_notification_activation_boundary(
  p_path text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.notification_activation_boundaries%ROWTYPE;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'record_notification_activation_boundary: a caller-generated request_id is required — it is what makes an ambiguous commit recoverable';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'record_notification_activation_boundary: a reason (3-500 chars) is required';
  END IF;
  -- serialize per path: two operators opening the same path converge on ONE boundary rather than
  -- racing to write two different instants
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-activation-boundary:' || coalesce(p_path, ''), 0));

  SELECT * INTO b FROM public.notification_activation_boundaries WHERE path = p_path FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_notification_activation_boundary: % is not a known delivery path', p_path;
  END IF;
  IF b.state = 'active' THEN
    -- an exact replay recovers the same decision; anything else is refused, because moving a
    -- boundary is how excluded history gets re-admitted
    IF b.request_id IS NOT DISTINCT FROM p_request_id THEN RETURN 'replayed'; END IF;
    RETURN 'already_active';
  END IF;
  UPDATE public.notification_activation_boundaries
     SET state = 'active', boundary_at = now(), request_id = p_request_id,
         reason = btrim(p_reason), activated_by = auth.uid()
   WHERE path = p_path;
  RETURN 'activated';
END;
$$;
COMMENT ON FUNCTION public.record_notification_activation_boundary(text, text, uuid) IS
  'N5: open a delivery path, once. Returns activated | replayed (same request id) | already_active (a different request — REFUSED, because moving a boundary re-admits the history it excluded). The boundary is now() at the moment of opening, so only events resolved after this call can enter the path.';
REVOKE ALL ON FUNCTION public.record_notification_activation_boundary(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_notification_activation_boundary(text, text, uuid) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- ENFORCEMENT 1 — the INSTANT claim. Recreated whole (its newest definition is M2's kill-switch
-- version, 20261017100000) with the boundary gate added directly after the kill gate and BEFORE
-- any ledger mutation: an inert path leaves no trace of having been asked.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.claim_notification_outbox_batch(
  p_channel text,
  p_worker  text,
  p_limit   int DEFAULT 20,
  p_stale_after_minutes int DEFAULT 15
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
DECLARE v_boundary timestamptz;
BEGIN
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN;
  END IF;

  -- N5 NO-BACKLOG BOUNDARY. Fail-closed: an inert path claims nothing at all, and an active one
  -- may only take rows CREATED at or after the instant it was opened. Placed before the
  -- cap-cancel and the reap so an inert path makes NO ledger mutations through this worker —
  -- the same rule the kill gate follows.
  v_boundary := public.notif_activation_boundary(p_channel || ':instant');
  IF v_boundary IS NULL THEN
    RETURN;
  END IF;

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
    AND locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    WHERE o.channel = p_channel
      AND o.delivery_mode IS DISTINCT FROM 'digest'
      -- THE BOUNDARY, applied to both arms below: a pre-boundary row is not "due later", it is
      -- never eligible on this path — including as an orphan reclaim, which would otherwise let
      -- a historical row that was mid-flight at activation slip through the side door.
      AND o.created_at >= v_boundary
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
COMMENT ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) IS
  'The instant worker''s atomic claim. Gates, in order: the channel KILL switch, then the N5 ACTIVATION BOUNDARY (inert path = claim nothing; active path = only rows created at or after boundary_at, on the fresh AND the orphan-reclaim arm). Then the live academy-cap cancel, the stale reap, and the FOR UPDATE SKIP LOCKED claim.';
REVOKE ALL ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- ENFORCEMENT 2 — MATERIALIZE, where a row enters the digest path. Recreated from its newest
-- definition (20261017100000, the kill-switch version) with the boundary gate added after the
-- kill gate and the boundary predicate added to BOTH scans. Everything else is byte-identical.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.materialize_notification_digest_groups(
    p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int, p_max_members_per_call int)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget int := 92160;                 -- ~90 KB cumulative byte budget per group
  v_groups int := 0; v_members int := 0; v_iter int := 0; v_lock_skips int := 0;
  cand record; m record;
  v_ckey jsonb; v_hash text; v_group uuid; v_count int; v_bytes int; v_next_chunk int; v_n int;
  v_boundary timestamptz;
BEGIN
  -- N4 M2 KILL SWITCH — a killed channel forms no new groups: materialization is a ledger
  -- mutation, and shaping work while killed would hand the un-kill a pre-built send backlog.
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN 0;
  END IF;

  -- N5 NO-BACKLOG BOUNDARY — materialization is where a row ENTERS the digest path, so it is
  -- where the boundary belongs. Fail-closed: while the path is inert nothing is shaped at all,
  -- which is what stops an engine-enable from handing the activation a pre-built backlog.
  v_boundary := public.notif_activation_boundary(p_channel || ':digest');
  IF v_boundary IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM notif_digest_assert_run(p_run_id, 'materialize', p_channel);
  PERFORM notif_digest_require_range(p_max_groups, 1, 1000, 'materialize: p_max_groups');
  PERFORM notif_digest_require_range(p_max_members_per_call, 1, 10000, 'materialize: p_max_members_per_call');
  LOOP
    v_iter := v_iter + 1;
    EXIT WHEN v_groups >= p_max_groups OR v_members >= p_max_members_per_call
           OR v_iter > (2 * greatest(p_max_groups, 1) + 8);   -- hard bound: never unbounded
    -- (1) earliest unassigned candidate — Index Scan on idx_outbox_digest_forming, one row.
    -- ORDER BY the index prefix ONLY (channel, digest_boundary_at): with LIMIT 1 this is a pure index scan —
    -- no sort over same-boundary ties. Any due candidate is fine (the per-key member query below imposes the
    -- deterministic created_at,id order WITHIN the key); earliest-boundary keys still drain first.
    SELECT o.id, o.recipient_key, o.destination_fingerprint, o.event_type, o.template_key, o.template_version,
           o.group_locale, o.digest_frequency, o.digest_boundary_at, o.tenant_academy_profile_id,
           o.tenant_trainer_id, o.digest_group_hash, coalesce(o.recipient_timezone,'Europe/Amsterdam') AS tz
      INTO cand
      FROM public.notification_outbox o
     WHERE o.channel = p_channel AND o.delivery_mode = 'digest'
       AND o.digest_group_id IS NULL AND o.status = 'pending'
       AND o.created_at >= v_boundary          -- N5: pre-boundary rows never enter this path
     ORDER BY o.digest_boundary_at
     LIMIT 1 FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND;

    v_ckey := notif_digest_canonical_key(p_channel, cand.recipient_key, cand.destination_fingerprint,
      cand.tenant_academy_profile_id, cand.tenant_trainer_id, cand.event_type, cand.template_key,
      cand.template_version, cand.group_locale, cand.digest_frequency, cand.tz, cand.digest_boundary_at);
    v_hash := coalesce(cand.digest_group_hash, encode(sha256(convert_to(v_ckey::text, 'UTF8')), 'hex'));
    -- (2) NONBLOCKING per-key serialization: a busy key means another materializer owns it right now —
    -- skip it (its members complete there or on the next call). Blocking acquisition of MULTIPLE keys per
    -- transaction could deadlock two materializers acquiring in opposite order; try-lock cannot.
    IF NOT pg_try_advisory_xact_lock(hashtext(v_hash)) THEN
      v_lock_skips := v_lock_skips + 1;
      IF v_lock_skips >= 3 THEN EXIT; END IF;   -- persistent contention → yield; the next call resumes
      CONTINUE;
    END IF;
    v_next_chunk := coalesce((SELECT max(chunk_ordinal) FROM public.notification_digest_groups
                              WHERE canonical_group_key = v_ckey), -1);
    v_group := NULL; v_count := 0; v_bytes := 0;

    -- (3) this key's members, bounded + locked; chunk into ≤50-item / ≤budget groups.
    FOR m IN
      SELECT o.id, coalesce(o.digest_item_bytes, 0) AS bytes
        FROM public.notification_outbox o
       WHERE o.digest_group_hash = v_hash                      -- index equality (idx_outbox_digest_member_scan)
         AND o.channel = p_channel AND o.delivery_mode = 'digest'
         AND o.digest_group_id IS NULL AND o.status = 'pending'
         -- N5: the SAME boundary as the candidate scan. Without it a pre-boundary row sharing a
         -- post-boundary row's key would be swept into its group — the flood arriving one
         -- membership hop later, inside a legitimately formed digest.
         AND o.created_at >= v_boundary
         -- exact-field checks retained: a (theoretical) hash collision must never co-mingle keys
         AND o.recipient_key = cand.recipient_key AND o.destination_fingerprint = cand.destination_fingerprint
         AND o.digest_boundary_at = cand.digest_boundary_at
         AND o.event_type IS NOT DISTINCT FROM cand.event_type
         AND o.template_key IS NOT DISTINCT FROM cand.template_key
         AND o.template_version IS NOT DISTINCT FROM cand.template_version
         AND o.group_locale IS NOT DISTINCT FROM cand.group_locale
         AND o.digest_frequency IS NOT DISTINCT FROM cand.digest_frequency
         AND o.tenant_academy_profile_id IS NOT DISTINCT FROM cand.tenant_academy_profile_id
         AND o.tenant_trainer_id IS NOT DISTINCT FROM cand.tenant_trainer_id
         AND coalesce(o.recipient_timezone,'Europe/Amsterdam') = cand.tz
       ORDER BY o.created_at, o.id
       LIMIT greatest(p_max_members_per_call - v_members, 1)
       FOR UPDATE SKIP LOCKED
    LOOP
      -- raw single-item oversize: its own oversize_failed group (member finalized).
      IF m.bytes > v_budget THEN
        EXIT WHEN v_groups >= p_max_groups;
        v_next_chunk := v_next_chunk + 1;
        INSERT INTO public.notification_digest_groups
          (canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
           destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
           digest_boundary_at, available_at, state, item_count, total_item_bytes, terminal_reason)
        VALUES (v_ckey, v_hash, v_next_chunk, p_channel, cand.event_type, cand.recipient_key,
                cand.destination_fingerprint, cand.tenant_academy_profile_id, cand.tenant_trainer_id, cand.tz,
                cand.digest_boundary_at, cand.digest_boundary_at, 'oversize_failed', 1, m.bytes, 'single_item_oversize')
        RETURNING id INTO v_group;
        UPDATE public.notification_outbox SET digest_group_id = v_group, status = 'failed',
               skip_reason = 'single_item_oversize', payload = NULL, digest_item = NULL, updated_at = p_now
         WHERE id = m.id AND digest_group_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n <> 1 THEN RAISE EXCEPTION 'materialize: oversize member % re-point race', m.id; END IF;
        PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'oversize_failed', 1);
        v_groups := v_groups + 1; v_members := v_members + 1; v_group := NULL; v_count := 0; v_bytes := 0;
        CONTINUE;
      END IF;

      -- open a new chunk when none is open, the 50-item cap is hit, or the byte budget would overflow.
      IF v_group IS NULL OR v_count >= 50 OR (v_bytes + m.bytes) > v_budget THEN
        EXIT WHEN v_groups >= p_max_groups;
        v_next_chunk := v_next_chunk + 1;
        INSERT INTO public.notification_digest_groups
          (canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
           destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
           digest_boundary_at, available_at, state)
        VALUES (v_ckey, v_hash, v_next_chunk, p_channel, cand.event_type, cand.recipient_key,
                cand.destination_fingerprint, cand.tenant_academy_profile_id, cand.tenant_trainer_id, cand.tz,
                cand.digest_boundary_at, cand.digest_boundary_at, 'pending')
        RETURNING id INTO v_group;
        v_groups := v_groups + 1; v_count := 0; v_bytes := 0;
        PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'materialized', 0);
      END IF;

      -- conditional, count-checked assignment: a member joins exactly one group (locked + still unassigned).
      UPDATE public.notification_outbox SET digest_group_id = v_group, updated_at = p_now
       WHERE id = m.id AND digest_group_id IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN
        v_count := v_count + 1; v_bytes := v_bytes + m.bytes; v_members := v_members + 1;
        UPDATE public.notification_digest_groups SET item_count = v_count, total_item_bytes = v_bytes,
               updated_at = p_now WHERE id = v_group;
      END IF;
    END LOOP;

    -- defensive: an opened chunk that ended up with zero members (all conditional assigns lost) → no_work.
    IF v_group IS NOT NULL AND v_count = 0 THEN
      UPDATE public.notification_digest_groups SET state = 'no_work', terminal_reason = 'no_members', updated_at = p_now
       WHERE id = v_group;
      PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'no_work', 0);
    END IF;
  END LOOP;
  RETURN v_groups;
END $$;

COMMENT ON FUNCTION public.materialize_notification_digest_groups(uuid, text, timestamptz, int, int) IS
  'Forms digest groups from pending digest-mode outbox rows. Gates, in order: the channel KILL switch, then the N5 ACTIVATION BOUNDARY for <channel>:digest (inert = form nothing; active = only rows created at or after boundary_at, applied to the candidate AND member scans so a pre-boundary row cannot join a post-boundary group).';
