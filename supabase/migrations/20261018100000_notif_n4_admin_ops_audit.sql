-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M3 — the platform-admin OPS AUDIT (contract finding 14 + the four M2-review pins).
--
-- One append-only table records every platform-admin notification DECISION — including no-ops
-- ("already_killed" is a decision the admin took, even though it changed nothing) — with TYPED
-- old/new scalars, never row dumps. UNIQUE (actor, request_id) is GLOBAL: one id names one
-- decision regardless of action or target, so a request id can never be replayed into a
-- different operation anywhere on the admin surface.
--
-- THE PINNED ORDERING (review, binding): the GLOBAL (actor, request_id) advisory lock comes
-- FIRST — before the replay lookup and before every control-specific lock. A unique constraint
-- alone would reintroduce generic conflict errors for concurrent identical requests; the lock
-- makes them SERIALIZE, so the loser finds the winner's audit row and replays its ORIGINAL
-- result with no second entry.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.notification_admin_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       uuid NOT NULL,                    -- auth.uid(): every audited op is admin-authenticated
  request_id  uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('channel_kill')),   -- grows per reviewed milestone
  target      text NOT NULL CHECK (length(btrim(target)) BETWEEN 1 AND 100),
  -- TYPED scalars, schema-controlled — never a row dump. For channel_kill they are the
  -- killed-state before/after ('live'|'killed').
  old_value   text NOT NULL CHECK (length(old_value) BETWEEN 1 AND 100),
  new_value   text NOT NULL CHECK (length(new_value) BETWEEN 1 AND 100),
  outcome     text NOT NULL CHECK (outcome IN ('applied', 'already_killed')),
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- GLOBAL: one request id = one decision, across every action and target this table will
  -- ever carry. (A rejected REUSE of an id cannot write a second DECISION row — it is recorded
  -- in notification_admin_rejected_attempts below and surfaces as a typed refusal verdict.)
  CONSTRAINT uq_notification_admin_audit_request UNIQUE (actor, request_id),
  -- SCHEMA-typed coherence per action — length checks alone would let owner-direct writes
  -- record incoherent evidence (target=arbitrary, old=foo, new=bar) forever, append-only.
  CONSTRAINT chk_notification_admin_audit_coherent CHECK (
    action <> 'channel_kill'
    OR (target IN ('email', 'whatsapp')
        AND new_value = 'killed'
        AND ((outcome = 'applied' AND old_value = 'live')
          OR (outcome = 'already_killed' AND old_value = 'killed')))
  )
);

-- N3-hardening + BEFORE TRUNCATE (finding 14): rows are born complete and never change.
CREATE OR REPLACE FUNCTION public.notif_admin_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'notification_admin_audit is append-only evidence — no %', TG_OP;
END;
$$;

CREATE TRIGGER trg_notif_admin_audit_guard
  BEFORE UPDATE OR DELETE ON public.notification_admin_audit
  FOR EACH ROW EXECUTE FUNCTION public.notif_admin_audit_guard();
CREATE TRIGGER trg_notif_admin_audit_no_truncate
  BEFORE TRUNCATE ON public.notification_admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_admin_audit_guard();

COMMENT ON TABLE public.notification_admin_audit IS
  'N4 M3: append-only record of every platform-admin notification decision (including no-ops), typed old/new scalars only. UNIQUE (actor, request_id) is GLOBAL — one id, one decision, any action. Owner-effective guard: no UPDATE/DELETE/TRUNCATE by any path.';

REVOKE ALL ON public.notification_admin_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX idx_notification_admin_audit_keyset
  ON public.notification_admin_audit (created_at DESC, id DESC);


-- ── the REJECTED-ATTEMPT record (finding 14: audit rejected attempts) ───────────────────────
-- A conflicting reuse of a request id is itself evidence — who tried, what they tried, when.
-- It CANNOT live in the decision table (the global uniqueness owns that id), and it cannot be
-- written on a RAISE path (the insert would roll back with it) — so the RPC returns a TYPED
-- refusal verdict ('rejected_request_reuse') for this one arm, letting the record commit.
-- Boundary, stated explicitly: only AUTHENTICATED-ADMIN attempts that passed validation and
-- then conflicted at replay are recorded here; non-admin and malformed-request probing raises
-- pre-decision and stays in the security/edge logging domain — an unauthenticated writer into
-- a database audit table would be a DoS surface.
CREATE TABLE public.notification_admin_rejected_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor         uuid NOT NULL,
  request_id    uuid NOT NULL,               -- deliberately NOT unique: every attempt is recorded
  action        text NOT NULL CHECK (action IN ('channel_kill')),
  target        text NOT NULL CHECK (length(btrim(target)) BETWEEN 1 AND 100),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  conflict_with text NOT NULL CHECK (length(conflict_with) BETWEEN 3 AND 500),  -- what the id already meant
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- the same schema-level typing as the decision table: owner-direct writes cannot record an
  -- attempt against a target the action does not have
  CONSTRAINT chk_notification_admin_rejected_coherent CHECK (
    action <> 'channel_kill' OR target IN ('email', 'whatsapp'))
);

CREATE TRIGGER trg_notif_admin_rejected_guard
  BEFORE UPDATE OR DELETE ON public.notification_admin_rejected_attempts
  FOR EACH ROW EXECUTE FUNCTION public.notif_admin_audit_guard();
CREATE TRIGGER trg_notif_admin_rejected_no_truncate
  BEFORE TRUNCATE ON public.notification_admin_rejected_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_admin_audit_guard();

COMMENT ON TABLE public.notification_admin_rejected_attempts IS
  'N4 M3: append-only record of authenticated-admin attempts REFUSED at replay (a request id reused for a different decision). Written on the typed-verdict path — never a RAISE path, which would roll the record back. Pre-validation refusals (non-admin, malformed) are deliberately NOT here: they raise before any decision exists.';

REVOKE ALL ON public.notification_admin_rejected_attempts FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX idx_notification_admin_rejected_keyset
  ON public.notification_admin_rejected_attempts (created_at DESC, id DESC);


-- ── admin_activate_channel_kill, rewired through the audit (M2 semantics preserved) ─────────
-- Ordering per the pins: GLOBAL request lock → audit replay lookup (exact match returns the
-- ORIGINAL result, no second entry; mismatch is a typed refusal) → the per-channel kill lock →
-- decide → ONE audit row. The kill row itself stays exactly as M2 shipped it: first-kill
-- evidence, SET-only, and nothing here (or anywhere) may update or delete it.
CREATE OR REPLACE FUNCTION public.admin_activate_channel_kill(
  p_channel text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.notification_admin_audit%ROWTYPE;
  v_outcome text;
  v_old text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: platform admin only';
  END IF;
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: unknown channel %', p_channel;
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: a reason (3-500 chars) is required';
  END IF;

  -- 1. the GLOBAL admin-request lock — one id, one decision, across the whole admin surface.
  --    Concurrent identical requests serialize HERE; the loser replays the winner's audit row.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-admin-req:' || auth.uid()::text || ':' || p_request_id::text, 0));

  -- 2. replay lookup against the AUDIT — the durable memory of what this id decided.
  SELECT * INTO a FROM public.notification_admin_audit
   WHERE actor = auth.uid() AND request_id = p_request_id;
  IF FOUND THEN
    IF a.action = 'channel_kill' AND a.target = p_channel AND a.reason = btrim(p_reason) THEN
      -- exact replay: the ORIGINAL result, and no second entry
      RETURN CASE a.outcome WHEN 'applied' THEN 'killed' ELSE a.outcome END;
    END IF;
    -- the REFUSAL is itself recorded — on the RETURN path, never a RAISE (which would roll
    -- the record back). The original decision row is untouched; this attempt gets its own.
    INSERT INTO public.notification_admin_rejected_attempts (actor, request_id, action, target, reason, conflict_with)
    VALUES (auth.uid(), p_request_id, 'channel_kill', p_channel, btrim(p_reason),
            format('action %s, target %s, reason %s', a.action, a.target, a.reason));
    RETURN 'rejected_request_reuse';
  END IF;

  -- 3. the per-channel kill lock (the one every claim path shares) — strictly AFTER the
  --    request lock, per the pinned ordering.
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));
  IF EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel) THEN
    v_old := 'killed'; v_outcome := 'already_killed';   -- a decision that changed nothing — still audited
  ELSE
    v_old := 'live'; v_outcome := 'applied';
    INSERT INTO public.notification_channel_kill_switches (channel, activated_by, reason, request_id)
    VALUES (p_channel, auth.uid(), btrim(p_reason), p_request_id);
  END IF;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'channel_kill', p_channel, v_old, 'killed', v_outcome, btrim(p_reason));

  RETURN CASE v_outcome WHEN 'applied' THEN 'killed' ELSE v_outcome END;
END;
$$;

COMMENT ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) IS
  'N4 M2+M3: the ONLY write on the kill surface, now audited. Ordering (pinned): global (actor,request_id) advisory lock → audit replay lookup (exact replay returns the original result with no second entry; a reused id is a typed refusal) → the shared per-channel kill lock → decide → one immutable audit row. already_killed is a decision that changed nothing and is audited as such (old=killed, new=killed); the FIRST kill''s evidence row is never touched. There is deliberately NO clearing counterpart.';

REVOKE ALL ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) TO authenticated, service_role;


-- ── the keyset reader (N3 pattern: composite (created_at, id), fixed columns, clamped) ──────
CREATE OR REPLACE FUNCTION public.admin_list_notification_audit(
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid,
  actor uuid,
  request_id uuid,
  action text,
  target text,
  old_value text,
  new_value text,
  outcome text,
  reason text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_list_notification_audit: platform admin only';
  END IF;
  -- the cursor is BOTH fields or NEITHER: a half-cursor silently drops or repeats rows
  -- (timestamp-only loses same-timestamp siblings; id-only restarts from page one)
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'admin_list_notification_audit: a keyset cursor needs BOTH created_at and id (or neither)';
  END IF;
  RETURN QUERY
  SELECT t.id, t.actor, t.request_id, t.action, t.target, t.old_value, t.new_value,
         t.outcome, t.reason, t.created_at
    FROM public.notification_admin_audit t
   WHERE p_before_created_at IS NULL
      OR (t.created_at, t.id) < (p_before_created_at, p_before_id)
   ORDER BY t.created_at DESC, t.id DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;

COMMENT ON FUNCTION public.admin_list_notification_audit(timestamptz, uuid, int) IS
  'N4 M3: platform-admin keyset read over the ops audit — composite (created_at, id) cursor (the N3 pagination pattern: no OFFSET, no drift under concurrent inserts), fixed columns, limit clamped 1..200, fail-closed admin check.';

REVOKE ALL ON FUNCTION public.admin_list_notification_audit(timestamptz, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_notification_audit(timestamptz, uuid, int) TO authenticated, service_role;


-- ── the rejected-attempts reader — evidence must be REACHABLE, not merely durable ───────────
CREATE OR REPLACE FUNCTION public.admin_list_notification_rejected(
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid,
  actor uuid,
  request_id uuid,
  action text,
  target text,
  reason text,
  conflict_with text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_list_notification_rejected: platform admin only';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'admin_list_notification_rejected: a keyset cursor needs BOTH created_at and id (or neither)';
  END IF;
  RETURN QUERY
  SELECT t.id, t.actor, t.request_id, t.action, t.target, t.reason, t.conflict_with, t.created_at
    FROM public.notification_admin_rejected_attempts t
   WHERE p_before_created_at IS NULL
      OR (t.created_at, t.id) < (p_before_created_at, p_before_id)
   ORDER BY t.created_at DESC, t.id DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;

COMMENT ON FUNCTION public.admin_list_notification_rejected(timestamptz, uuid, int) IS
  'N4 M3: platform-admin keyset read over rejected admin attempts — the same contract as the decision reader (composite cursor both-or-neither, newest-first, fixed columns, clamp 1..200, fail-closed admin check).';

REVOKE ALL ON FUNCTION public.admin_list_notification_rejected(timestamptz, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_notification_rejected(timestamptz, uuid, int) TO authenticated, service_role;
