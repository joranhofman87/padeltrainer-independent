-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N3 M2 — academy notification restrictions + append-only audit (design contract findings 7-10,
-- thread 019fd175-f39e-73a3-80c3-7c43f6b13f97).
--
-- THE MODEL: a restriction is a CAP, never a floor. effective = most_restrictive(player, cap)
-- over instant > daily > weekly > off. A cap can silence or slow an OPTIONAL event for one
-- academy's attributed sends; it can never resurrect a player's own 'off', never touch a
-- required event, and never create consent (it does not know notification_contacts exists).
-- Absence of a row = inherit. There is no 'instant' arm — a no-op cap is expressed by deleting
-- the row (returning to inherit), so the table can never carry rows that look like controls but
-- do nothing.
--
-- VALIDATION LIVES ON THE TABLE (finding 10), not only in the RPC: a future definer writer or a
-- service-role migration must hit the same wall. The trigger re-reads the catalog, so an event
-- flipped to required AFTER a cap exists is caught at the next write — and the resolver ignores
-- caps on required events at READ time regardless (finding 7: the required-email override runs
-- LAST; M3 wires it).
--
-- THE AUDIT IS STRUCTURALLY APPEND-ONLY (finding 8): a guard trigger refuses UPDATE/DELETE for
-- every role including the owner (the digest-ledger pattern); no FK cascades into history —
-- academy/actor/event are plain uuids/text snapshots, so deleting an academy can never erase
-- what its managers did. request_id makes the WRITE idempotent (finding 9): a retried browser
-- request replays its result without a second audit row; the same id with DIFFERENT arguments
-- is refused — a request id names ONE decision.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.academy_notification_restrictions (
  academy_profile_id uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  event_type         text NOT NULL REFERENCES public.notification_event_types(key),
  channel            text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  max_frequency      text NOT NULL CHECK (max_frequency IN ('daily','weekly','off')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (academy_profile_id, event_type, channel)
);

COMMENT ON TABLE public.academy_notification_restrictions IS
  'N3: per-academy CAPS on optional notification events — most-restrictive-wins against the player''s own preference, never a floor (a player''s off is untouchable), never applicable to required_delivery events (refused at write by trigger AND ignored at read by the resolver). Absence = inherit. No instant arm: a no-op cap is DELETE. Written only via set_academy_notification_restriction (audited, idempotent); read at send time keyed on the outbox row''s tenant_academy_profile_id.';

-- Catalog-aware validation, on the TABLE so every writer hits it.
CREATE OR REPLACE FUNCTION public.notif_academy_restriction_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_evt public.notification_event_types%ROWTYPE;
BEGIN
  SELECT * INTO v_evt FROM public.notification_event_types WHERE key = NEW.event_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'academy_notification_restrictions: unknown event %', NEW.event_type;
  END IF;
  IF v_evt.required_delivery THEN
    RAISE EXCEPTION 'academy_notification_restrictions: % is required_delivery — a tenant may never weaken a required notification', NEW.event_type;
  END IF;
  IF (NEW.channel = 'email'    AND NOT v_evt.supports_email)
  OR (NEW.channel = 'whatsapp' AND NOT v_evt.supports_whatsapp)
  OR (NEW.channel = 'push'     AND NOT v_evt.supports_push) THEN
    -- A cap on a channel the event cannot use is not harmless: it is durable UI state and an
    -- audit trail claiming control over something that can never affect delivery.
    RAISE EXCEPTION 'academy_notification_restrictions: % does not support channel %', NEW.event_type, NEW.channel;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notif_academy_restriction_guard
  BEFORE INSERT OR UPDATE ON public.academy_notification_restrictions
  FOR EACH ROW EXECUTE FUNCTION public.notif_academy_restriction_guard();

-- ── the audit ───────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.academy_notification_restriction_audit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL,          -- NO FK: history must survive the academy
  actor_user_id      uuid NOT NULL,          -- NO FK: history must survive the account
  event_type         text NOT NULL,          -- NO FK: history must survive a catalog rename
  channel            text NOT NULL,
  old_max_frequency  text,                   -- NULL = was inherit
  new_max_frequency  text,                   -- NULL = returned to inherit
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  request_id         uuid NOT NULL,
  txid               bigint NOT NULL DEFAULT txid_current(),  -- ops correlation, NOT idempotency
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Finding 9: one request id names ONE decision by ONE actor in ONE academy.
CREATE UNIQUE INDEX uq_notif_restriction_audit_request
  ON public.academy_notification_restriction_audit (actor_user_id, academy_profile_id, request_id);
-- Finding 8: the read paths (manager history, player history) are per-academy, newest first.
CREATE INDEX idx_notif_restriction_audit_academy
  ON public.academy_notification_restriction_audit (academy_profile_id, created_at DESC);

COMMENT ON TABLE public.academy_notification_restriction_audit IS
  'N3: append-only history of every academy restriction change — actor, academy, event/channel, old→new cap, mandatory reason, client request_id (idempotency: UNIQUE per actor+academy; replay returns the prior result without a second row; same id with different arguments is refused), txid for ops correlation. Guard trigger refuses UPDATE/DELETE for every role; no FK cascades — history outlives academies, accounts and catalog rows.';

CREATE OR REPLACE FUNCTION public.notif_restriction_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'academy_notification_restriction_audit is append-only';
END;
$$;

CREATE TRIGGER trg_notif_restriction_audit_guard
  BEFORE UPDATE OR DELETE ON public.academy_notification_restriction_audit
  FOR EACH ROW EXECUTE FUNCTION public.notif_restriction_audit_guard();

-- ── ACLs: definer RPCs are the only interface ───────────────────────────────────────────────
-- service_role is revoked EXPLICITLY: this project's ALTER DEFAULT PRIVILEGES grants it ALL on
-- new tables and it holds BYPASSRLS, so a bare revoke of anon/authenticated would leave every
-- edge function able to write caps unaudited or rewrite history (the S1 lesson).
REVOKE ALL ON public.academy_notification_restrictions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.academy_notification_restrictions TO service_role;  -- send-time reads
REVOKE ALL ON public.academy_notification_restriction_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.academy_notification_restriction_audit TO service_role;

-- ── the write RPC ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_academy_notification_restriction(
  p_academy_profile_id uuid,
  p_event_type text,
  p_channel text,
  p_max_frequency text,   -- NULL = return to inherit (delete the cap)
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_old text;
  v_prior public.academy_notification_restriction_audit%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'set_academy_notification_restriction: anonymous callers may not manage restrictions';
  END IF;
  IF p_academy_profile_id IS NULL OR p_event_type IS NULL OR p_channel IS NULL
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'set_academy_notification_restriction: academy, event, channel and request_id are required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'set_academy_notification_restriction: a reason (3-500 chars) is required — the audit is the point';
  END IF;
  IF p_max_frequency IS NOT NULL AND p_max_frequency NOT IN ('daily','weekly','off') THEN
    RAISE EXCEPTION 'set_academy_notification_restriction: max_frequency must be daily|weekly|off, or NULL to inherit';
  END IF;
  IF NOT public.is_academy_manager(v_actor, p_academy_profile_id) THEN
    RAISE EXCEPTION 'set_academy_notification_restriction: not a manager of this academy';
  END IF;

  -- REQUEST-ID IDEMPOTENCY (finding 9), before any state change. A replay of the SAME decision
  -- returns the recorded outcome without a second audit row; the same id carrying a DIFFERENT
  -- decision is a caller bug and is refused — a request id names one decision.
  --
  -- The REQUEST lock comes FIRST, before the replay lookup: without it, two SIMULTANEOUS exact
  -- retries both find no audit row, both proceed, and the loser hits the unique index with an
  -- ERROR where the contract promises 'replayed'. Namespaced, so neither this nor the triple
  -- lock below can collide with another advisory-lock user by format alone.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-academy-restriction-req:' || v_actor::text || ':'
                     || p_academy_profile_id::text || ':' || p_request_id::text, 0));
  SELECT * INTO v_prior FROM public.academy_notification_restriction_audit
   WHERE actor_user_id = v_actor AND academy_profile_id = p_academy_profile_id
     AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.event_type = p_event_type AND v_prior.channel = p_channel
       AND v_prior.new_max_frequency IS NOT DISTINCT FROM p_max_frequency
       AND v_prior.reason = btrim(p_reason) THEN
      -- the REASON is part of the decision evidence (it is audited and player-visible), so a
      -- replay must match it too — same id, different reason is a different decision.
      RETURN 'replayed';
    END IF;
    RAISE EXCEPTION 'set_academy_notification_restriction: request % was already used for a different change', p_request_id;
  END IF;

  -- Serialize same-triple writers so old→new in the audit is the truth. FOR UPDATE alone
  -- cannot do this for the FIRST write (no row exists to lock — two concurrent creators would
  -- both read NULL and one audit would lie about the transition), so the lock is a
  -- transaction-scoped ADVISORY lock derived from the triple, taken before the read.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-academy-restriction-triple:' || p_academy_profile_id::text || ':'
                     || p_event_type || ':' || p_channel, 0));
  SELECT max_frequency INTO v_old FROM public.academy_notification_restrictions
   WHERE academy_profile_id = p_academy_profile_id AND event_type = p_event_type
     AND channel = p_channel
   FOR UPDATE;

  IF p_max_frequency IS NULL THEN
    DELETE FROM public.academy_notification_restrictions
     WHERE academy_profile_id = p_academy_profile_id AND event_type = p_event_type
       AND channel = p_channel;
  ELSE
    INSERT INTO public.academy_notification_restrictions
      (academy_profile_id, event_type, channel, max_frequency)
    VALUES (p_academy_profile_id, p_event_type, p_channel, p_max_frequency)
    ON CONFLICT (academy_profile_id, event_type, channel)
      DO UPDATE SET max_frequency = EXCLUDED.max_frequency;
  END IF;

  INSERT INTO public.academy_notification_restriction_audit
    (academy_profile_id, actor_user_id, event_type, channel,
     old_max_frequency, new_max_frequency, reason, request_id)
  VALUES (p_academy_profile_id, v_actor, p_event_type, p_channel,
          v_old, p_max_frequency, btrim(p_reason), p_request_id);

  RETURN CASE
    WHEN p_max_frequency IS NULL AND v_old IS NULL THEN 'noop_inherit'
    WHEN p_max_frequency IS NULL THEN 'cleared'
    WHEN v_old IS NULL THEN 'set'
    ELSE 'changed'
  END;
END;
$$;

COMMENT ON FUNCTION public.set_academy_notification_restriction(uuid, text, text, text, text, uuid) IS
  'N3: the ONLY writer of academy notification caps. Manager-checked, reason-mandatory, request_id-idempotent (replay returns ''replayed'' with no second audit row; a reused id with different arguments is refused). NULL max_frequency returns the triple to inherit. The table trigger revalidates catalog constraints (required events, unsupported channels) on every write regardless of caller.';

-- ── the manager read RPC ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_academy_notification_restrictions(
  p_academy_profile_id uuid
) RETURNS TABLE (event_type text, channel text, max_frequency text, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'get_academy_notification_restrictions: not a manager of this academy';
  END IF;
  RETURN QUERY
  SELECT r.event_type, r.channel, r.max_frequency, r.updated_at
    FROM public.academy_notification_restrictions r
   WHERE r.academy_profile_id = p_academy_profile_id
   ORDER BY r.event_type, r.channel;
END;
$$;

-- ── the manager history RPC (finding 8's read path; the PLAYER history reader lands with the
--    membership reader in M4 — it needs the canonical person-ref semantics, not a quick join) ──

CREATE OR REPLACE FUNCTION public.get_academy_notification_restriction_audit(
  p_academy_profile_id uuid,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  event_type text, channel text, old_max_frequency text, new_max_frequency text,
  reason text, actor_user_id uuid, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'get_academy_notification_restriction_audit: not a manager of this academy';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'get_academy_notification_restriction_audit: limit must be 1..200';
  END IF;
  RETURN QUERY
  SELECT a.event_type, a.channel, a.old_max_frequency, a.new_max_frequency,
         a.reason, a.actor_user_id, a.created_at
    FROM public.academy_notification_restriction_audit a
   WHERE a.academy_profile_id = p_academy_profile_id
   ORDER BY a.created_at DESC
   LIMIT p_limit;
END;
$$;

-- Function ACLs: authenticated only (each re-checks the manager grant); anon nothing;
-- service_role kept for the write so N4's admin ops can act with its own audit trail later.
REVOKE ALL ON FUNCTION public.set_academy_notification_restriction(uuid, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_academy_notification_restriction(uuid, text, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_academy_notification_restrictions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_notification_restrictions(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_academy_notification_restriction_audit(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_notification_restriction_audit(uuid, int) TO authenticated;
