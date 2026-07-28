-- 10c-a3 PR-1 (SQL reliability) — harden the v1 email-delivery state machine + add the Resend suppression lifecycle.
--
-- WHY (Codex 10c-a3 review):
--   1. record_email_event() read address state WITHOUT a lock, then did an unconditional upsert → concurrent
--      complained/delivered could both read 'ok' and the LAST upsert wins; it was also NOT timestamp-aware, so an
--      out-of-order OLDER `delivered` cleared a NEWER bounce. On the upgrade path, existing rows had no recency clock
--      — and last_event_at is NOT an authoritative state clock (the old writer advances it for sent/send_failed/
--      failed/delivery_delayed, which do NOT change state), so the backfill below derives state_changed_at from the
--      STATE-PRODUCING event history.
--   2. Resend emits `email.suppressed` (added to the provider suppression list) AND `suppression.removed`. The prior
--      model had no suppression signal and no recovery lifecycle.
--
-- FIX:
--   • Per-address transition is ATOMIC (ensure row → SELECT … FOR UPDATE) and RECENCY-aware via state_changed_at:
--     the state reflects the MOST RECENT delivery signal; an older event never overrides a newer state. `sent` is
--     API-acceptance (not delivery evidence) → INITIALIZES a new address only. `complained` is sticky vs ordinary
--     delivery but MUST NOT resurrect after a NEWER operator reset (last_reset_at guard).
--   • Provider suppression is a SEPARATE, RECOVERABLE, unordered-safe axis (Option B) with a DETERMINISTIC
--     equal-timestamp tie (suppression-wins, fail-safe).
--   • last_event_type/at/reason FOLLOW THE WINNING TRANSITION (they advance only when this event actually set the
--     state / suppression axis) — never a stale or same-timestamp LOSER beside a contradicting state.
--   • ONE canonical predicate — the generated column is_suppressed — feeds is_email_suppressed() and (next migration)
--     every operator surface.
--   • reset_email_suppression is an INTERNAL service-role reset (no customer exposure). It writes an ordinary
--     internal event-log row for traceability — NOT an immutable audit trail (the log is retention-swept and
--     service_role can UPDATE/DELETE it) — and stamps the recency clocks so a stale callback cannot resurrect the
--     old state. An authorized/audited operator-facing wrapper (actor + tenant) is future work — do NOT expose this.
-- This migration touches the LIVE v1 bounce path; the v2 digest engine remains disabled.

-- ── 1. event-log: accept the two Resend suppression event types + the internal reset event type ───────────────
ALTER TABLE public.email_delivery_events DROP CONSTRAINT IF EXISTS email_delivery_events_event_type_check;
ALTER TABLE public.email_delivery_events ADD CONSTRAINT email_delivery_events_event_type_check
  CHECK (event_type IN
    ('sent','delivered','bounced','complained','delivery_delayed','failed','send_failed',
     'suppressed','suppression_removed','operator_reset'));

-- ── 1b. shared, pure state-axis transition — the SINGLE definition of the delivery-state rules, used by BOTH the
--        live writer AND the upgrade backfill (so the backfill CANNOT drift from the writer) ────────────────────
-- Given the current (state, state_changed_at, last_reset_at) and one event, return the next state + clocks and
-- whether this event WON the state transition. complaint sticky-but-reset-respecting (reset wins an equal-time tie);
-- delivered/bounced newest-wins with equal-time severity; `sent` is a NO-OP on state (API acceptance, not delivery
-- evidence — it never sets a recency barrier); operator_reset clears + stamps (replay path only).
CREATE OR REPLACE FUNCTION public.email_state_transition(
  p_state text, p_state_changed_at timestamptz, p_last_reset_at timestamptz,
  p_event_type text, p_bounce_type text, p_at timestamptz,
  OUT o_state text, OUT o_state_changed_at timestamptz, OUT o_last_reset_at timestamptz, OUT o_changed boolean)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_sig text; sev constant jsonb := '{"ok":0,"soft_bounced":1,"hard_bounced":2,"complained":3}'::jsonb;
BEGIN
  o_state := p_state; o_state_changed_at := p_state_changed_at; o_last_reset_at := p_last_reset_at; o_changed := false;
  v_sig := CASE p_event_type
             WHEN 'complained' THEN 'complained'
             WHEN 'bounced'    THEN CASE WHEN coalesce(p_bounce_type, 'hard') = 'hard' THEN 'hard_bounced' ELSE 'soft_bounced' END
             WHEN 'delivered'  THEN 'ok'
             ELSE NULL END;
  IF p_event_type = 'operator_reset' THEN
    o_state := 'ok'; o_state_changed_at := p_at; o_last_reset_at := p_at; o_changed := true;  -- clears both axes + stamps
  ELSIF p_state = 'complained' THEN
    NULL;                                                       -- sticky: only an operator reset (above) clears it
  ELSIF p_event_type = 'complained' THEN
    -- must not resurrect a complaint at-or-before a reset. EQUAL-TIME PRECEDENCE: the operator reset WINS (strict >),
    -- so a same-instant complaint (typically the very one being reset away) does not immediately re-suppress.
    IF p_last_reset_at IS NULL OR p_at > p_last_reset_at THEN
      o_state := 'complained'; o_state_changed_at := p_at; o_changed := true;
    END IF;
  ELSIF p_event_type = 'sent' THEN
    -- `sent` is API ACCEPTANCE, not delivery evidence: it must NEVER establish a state_changed_at barrier, or a
    -- delayed OLDER hard bounce/complaint (unordered webhook) would be wrongly rejected and the address stay sendable.
    NULL;
  ELSIF v_sig IS NOT NULL THEN
    IF p_state_changed_at IS NULL OR p_at > p_state_changed_at THEN
      o_state := v_sig; o_state_changed_at := p_at; o_changed := true;             -- a NEWER signal wins
    ELSIF p_at = p_state_changed_at AND (sev->>v_sig)::int > (sev->>p_state)::int THEN
      o_state := v_sig; o_state_changed_at := p_at; o_changed := true;             -- same instant → higher severity
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.email_state_transition(text, timestamptz, timestamptz, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- TOTAL deterministic ordering for equal-instant events (every meaningful event type has a DISTINCT rank, so a tie
-- can never make the "latest event" arrival-order-dependent). Suppressive / negative signals outrank positive ones,
-- so a same-timestamp `delivered` never overwrites a same-timestamp `complained`/`suppressed`/`bounced`.
CREATE OR REPLACE FUNCTION public.email_event_rank(p_event_type text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_event_type
    WHEN 'complained'          THEN 7
    WHEN 'suppressed'          THEN 6
    WHEN 'operator_reset'      THEN 5
    WHEN 'bounced'             THEN 4
    WHEN 'suppression_removed' THEN 3
    WHEN 'delivered'           THEN 2
    WHEN 'sent'                THEN 1
    ELSE 0 END;   -- failed / send_failed / delivery_delayed never win an axis, so never reach the last_event tiebreak
$$;
REVOKE ALL ON FUNCTION public.email_event_rank(text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. address rollup: recency clocks + the recoverable provider-suppression axis + the canonical predicate ────
ALTER TABLE public.email_address_state
  ADD COLUMN IF NOT EXISTS state_changed_at                timestamptz,            -- occurred_at of the event that set `state`
  ADD COLUMN IF NOT EXISTS last_reset_at                   timestamptz,            -- occurred_at of the last operator reset (complaint guard)
  ADD COLUMN IF NOT EXISTS provider_suppressed_active      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_suppression_changed_at timestamptz,            -- occurred_at of the last suppressed/removed transition
  ADD COLUMN IF NOT EXISTS provider_suppression_event_id   text;                   -- audit: the Svix id of that transition

-- UPGRADE-PATH BACKFILL: existing rows predate the recency clock AND were written by the OLD arrival-order-dependent
-- writer, so `state` itself can be wrong. RECOMPUTE the canonical rollup — state, state_changed_at, last_reset_at AND
-- last_event_type/at/reason — by REPLAYING the state-producing history in a TOTAL deterministic order through the SAME
-- email_state_transition() the live writer uses (so both directions self-heal: old `ok` despite a newer hard bounce →
-- suppressed; old hard bounce despite a newer delivery → ok).
-- PARTIAL / PURGED HISTORY FAIL-SAFE: a downgrade of an existing SUPPRESSED row (hard_bounced/soft_bounced/complained)
-- is only trusted when retained history contains the MATCHING SUPPRESSING ORIGIN (a replay over it will also honor any
-- later clearing evidence). If the origin has been retention-swept, a lone surviving `delivered` must NOT silently
-- clear it → PRESERVE the existing state (fail-safe clock = updated_at). Non-suppressed rows recompute freely.
DO $$
DECLARE
  r record; e record; t record;
  v_state text; v_sca timestamptz; v_lra timestamptz;
  v_let text; v_lea timestamptz; v_reason text;      -- last_event_* accumulators (newest WINNING transition, ranked)
  v_has_origin boolean;
BEGIN
  FOR r IN SELECT email, state AS old_state, updated_at FROM public.email_address_state WHERE state_changed_at IS NULL LOOP
    v_state := 'ok'; v_sca := NULL; v_lra := NULL; v_let := NULL; v_lea := NULL; v_reason := NULL;
    FOR e IN
      SELECT event_type, bounce_type, reason, occurred_at, resend_event_id
        FROM public.email_delivery_events
       WHERE recipient_email = r.email
         AND event_type IN ('sent', 'delivered', 'bounced', 'complained', 'operator_reset')
       ORDER BY occurred_at, public.email_event_rank(event_type), resend_event_id   -- TOTAL deterministic order
    LOOP
      SELECT * INTO t FROM public.email_state_transition(v_state, v_sca, v_lra, e.event_type, e.bounce_type, e.occurred_at);
      IF t.o_changed THEN   -- won the state transition → candidate for last_event_* (monotonic, ranked equal-instant tie)
        IF v_lea IS NULL OR e.occurred_at > v_lea
           OR (e.occurred_at = v_lea AND public.email_event_rank(e.event_type) >= public.email_event_rank(v_let)) THEN
          v_let := e.event_type; v_lea := e.occurred_at; v_reason := e.reason;
        END IF;
      END IF;
      v_state := t.o_state; v_sca := t.o_state_changed_at; v_lra := t.o_last_reset_at;
    END LOOP;

    v_has_origin := EXISTS (
      SELECT 1 FROM public.email_delivery_events ev WHERE ev.recipient_email = r.email
        AND ((r.old_state = 'complained'   AND ev.event_type = 'complained')
          OR (r.old_state = 'hard_bounced' AND ev.event_type = 'bounced' AND coalesce(ev.bounce_type, 'hard') = 'hard')
          OR (r.old_state = 'soft_bounced' AND ev.event_type = 'bounced' AND coalesce(ev.bounce_type, 'hard') = 'soft')));

    IF r.old_state IN ('hard_bounced', 'complained') AND NOT v_has_origin THEN
      -- purged/partial history for a SUPPRESSED row (only hard_bounced/complained feed is_suppressed) → never
      -- blind-downgrade; keep state + metadata, fail-safe clock. A soft_bounced row is NOT suppressed, so it recomputes
      -- freely below — this is what lets a retained NEWER hard bounce correctly UPGRADE an old soft_bounced row.
      UPDATE public.email_address_state
         SET state_changed_at = updated_at, last_reset_at = v_lra
       WHERE email = r.email;
    ELSE
      -- trustworthy: not currently suppressed, OR the suppressing origin IS retained (replay saw it + any later clear).
      UPDATE public.email_address_state
         SET state = v_state, state_changed_at = v_sca, last_reset_at = v_lra,
             last_event_type = coalesce(v_let, last_event_type),
             last_event_at   = coalesce(v_lea, last_event_at),
             reason          = CASE WHEN v_let IS NOT NULL THEN v_reason ELSE reason END
       WHERE email = r.email;
    END IF;
  END LOOP;
END $$;

-- Canonical "block sending / flag to operators" predicate — the SINGLE source of truth. A hard bounce or complaint
-- (state axis) OR an active provider suppression (suppression axis). Every reader references THIS column (or
-- is_email_suppressed, which reads it), so a future signal never leaves a reader stale.
ALTER TABLE public.email_address_state
  ADD COLUMN IF NOT EXISTS is_suppressed boolean
    GENERATED ALWAYS AS ((state IN ('hard_bounced','complained')) OR provider_suppressed_active) STORED;

CREATE INDEX IF NOT EXISTS idx_eas_is_suppressed ON public.email_address_state (email) WHERE is_suppressed;

COMMENT ON COLUMN public.email_address_state.is_suppressed IS
  'Canonical suppression predicate (generated): hard_bounced/complained OR an active Resend suppression. The single source of truth for is_email_suppressed() and every operator surface.';
COMMENT ON COLUMN public.email_address_state.provider_suppressed_active IS
  'Resend suppression-list membership (email.suppressed sets, suppression.removed clears) — a recoverable axis, orthogonal to bounce state; guarded by provider_suppression_changed_at for out-of-order safety (equal-time: suppression wins).';

-- ── 3. the single writer — atomic, recency-aware, with the suppression lifecycle ─────────────────────────────
CREATE OR REPLACE FUNCTION public.record_email_event(
  p_event_type        text,
  p_recipient_email   text,
  p_resend_email_id   text        DEFAULT NULL,
  p_resend_event_id   text        DEFAULT NULL,
  p_bounce_type       text        DEFAULT NULL,
  p_reason            text        DEFAULT NULL,
  p_invoice_id        uuid        DEFAULT NULL,
  p_academy_profile_id uuid       DEFAULT NULL,
  p_trainer_id        uuid        DEFAULT NULL,
  p_occurred_at       timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_email    text        := lower(btrim(p_recipient_email));
  v_at       timestamptz := coalesce(p_occurred_at, now());
  v_rows     integer;
  r          public.email_address_state%ROWTYPE;
  v_target   text;
  v_new_sca  timestamptz;               -- state_changed_at after the transition
  v_new_lra  timestamptz;               -- last_reset_at after the transition (only operator_reset changes it)
  v_changed  boolean := false;          -- did this event WIN the state transition? → advance state
  v_apply_sp boolean;                   -- did this event WIN the suppression transition?
  v_le_adv   boolean;                   -- may last_event_* advance? (won an axis AND chronologically newest across BOTH)
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN;
  END IF;

  -- operator_reset is NOT a provider callback — it is a deliberate two-axis reset (state + provider suppression). The
  -- generic writer only touches the state axis, so accepting it here would perform a PARTIAL reset (leaving provider
  -- suppression active). Reject it loudly and force the complete reset_email_suppression() path. (Pinned contract.)
  IF p_event_type = 'operator_reset' THEN
    RAISE EXCEPTION 'record_email_event: operator_reset is not a provider callback — use reset_email_suppression()';
  END IF;

  -- append the raw event (idempotent — a webhook retry sharing its Svix id is a no-op) ------------------------
  INSERT INTO public.email_delivery_events
    (resend_event_id, resend_email_id, event_type, bounce_type, reason,
     recipient_email, invoice_id, academy_profile_id, trainer_id, occurred_at)
  VALUES
    (p_resend_event_id, p_resend_email_id, p_event_type, p_bounce_type, p_reason,
     v_email, p_invoice_id, p_academy_profile_id, p_trainer_id, v_at)
  ON CONFLICT (resend_event_id) WHERE resend_event_id IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN;  -- duplicate webhook delivery — already processed
  END IF;

  -- ensure the address row exists, then LOCK it (serializes concurrent callbacks — the finding-1 race).
  INSERT INTO public.email_address_state (email, state) VALUES (v_email, 'ok')
    ON CONFLICT (email) DO NOTHING;
  SELECT * INTO r FROM public.email_address_state WHERE email = v_email FOR UPDATE;

  -- ── provider-suppression axis (recoverable, unordered-safe, deterministic equal-time tie) ────────────────
  IF p_event_type IN ('suppressed', 'suppression_removed') THEN
    -- apply when strictly newer; on an EQUAL timestamp, suppression WINS (fail-safe deterministic tie).
    v_apply_sp := r.provider_suppression_changed_at IS NULL
              OR v_at > r.provider_suppression_changed_at
              OR (v_at = r.provider_suppression_changed_at AND p_event_type = 'suppressed');
    -- last_event_* is the newest WINNING transition across BOTH axes: advance only if this event won its axis AND is
    -- chronologically newest vs the current last_event_at (deterministic equal-instant rank) — so a suppression at
    -- 12:00 is never overwritten by an older delivery at 11:00 that later wins the state axis.
    v_le_adv := v_apply_sp AND (r.last_event_at IS NULL OR v_at > r.last_event_at
                  OR (v_at = r.last_event_at AND public.email_event_rank(p_event_type) >= public.email_event_rank(r.last_event_type)));
    UPDATE public.email_address_state
       SET provider_suppressed_active      = CASE WHEN v_apply_sp THEN (p_event_type = 'suppressed') ELSE provider_suppressed_active END,
           provider_suppression_changed_at = CASE WHEN v_apply_sp THEN v_at ELSE provider_suppression_changed_at END,
           provider_suppression_event_id   = CASE WHEN v_apply_sp THEN p_resend_event_id ELSE provider_suppression_event_id END,
           last_event_type = CASE WHEN v_le_adv THEN p_event_type ELSE last_event_type END,
           last_event_at   = CASE WHEN v_le_adv THEN v_at ELSE last_event_at END,
           reason          = CASE WHEN v_le_adv THEN p_reason ELSE reason END,
           updated_at      = now()
     WHERE email = v_email;
    RETURN;
  END IF;

  -- ── delivery-state axis — via the SHARED transition helper (identical rules to the backfill replay) ──────────
  SELECT o_state, o_state_changed_at, o_last_reset_at, o_changed
    INTO v_target, v_new_sca, v_new_lra, v_changed
    FROM public.email_state_transition(r.state, r.state_changed_at, r.last_reset_at, p_event_type, p_bounce_type, v_at);

  -- last_event_* is the newest WINNING transition across BOTH axes (see the suppression branch): advance only when
  -- this event won the state transition AND is chronologically newest vs the current last_event_at.
  v_le_adv := v_changed AND (r.last_event_at IS NULL OR v_at > r.last_event_at
                OR (v_at = r.last_event_at AND public.email_event_rank(p_event_type) >= public.email_event_rank(r.last_event_type)));
  UPDATE public.email_address_state
     SET state            = v_target,
         state_changed_at  = v_new_sca,
         last_event_type  = CASE WHEN v_le_adv THEN p_event_type ELSE last_event_type END,
         last_event_at    = CASE WHEN v_le_adv THEN v_at ELSE last_event_at END,
         reason           = CASE WHEN v_le_adv THEN p_reason ELSE reason END,
         updated_at       = now()
   WHERE email = v_email;
END;
$$;

COMMENT ON FUNCTION public.record_email_event(text, text, text, text, text, text, uuid, uuid, uuid, timestamptz) IS
  'Email delivery tracking: idempotent (resend_event_id) event writer + ATOMIC (FOR UPDATE), RECENCY-aware address transition (complaint sticky but reset-respecting; suppressed/suppression_removed recoverable + unordered-safe, suppression-wins on tie). last_event_* follow the winning transition. service_role only.';
REVOKE ALL ON FUNCTION public.record_email_event(text, text, text, text, text, text, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_email_event(text, text, text, text, text, text, uuid, uuid, uuid, timestamptz)
  TO service_role;

-- ── 4. the canonical suppression check — reads the generated predicate (auto-picks up provider suppression) ────
CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_address_state
    WHERE email = lower(btrim(p_email))
      AND is_suppressed
  );
$$;
COMMENT ON FUNCTION public.is_email_suppressed(text) IS
  'Email delivery tracking: TRUE if the address is suppressed (hard-bounced / complained / provider-suppressed) — reads the canonical is_suppressed column. service_role only.';
REVOKE ALL ON FUNCTION public.is_email_suppressed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_email_suppressed(text) TO service_role;

-- ── 5. INTERNAL service-role reset (NOT a customer-facing operator action — see header) ──────────────────────
-- Clears both axes AND stamps the recency clocks (state_changed_at + last_reset_at + provider_suppression_changed_at)
-- so a later STALE callback cannot resurrect the old state, and writes an ordinary internal event-log row for
-- traceability (the log is retention-swept — this is NOT an immutable audit trail). An authorized/audited
-- operator wrapper (actor + tenant) must be added before this is exposed operationally.
CREATE OR REPLACE FUNCTION public.reset_email_suppression(p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_email text := lower(btrim(p_email)); v_now timestamptz := now();
BEGIN
  IF v_email IS NULL OR v_email = '' THEN RETURN; END IF;
  INSERT INTO public.email_address_state (email, state) VALUES (v_email, 'ok') ON CONFLICT (email) DO NOTHING;
  UPDATE public.email_address_state
     SET state = 'ok', state_changed_at = v_now, last_reset_at = v_now,
         provider_suppressed_active = false, provider_suppression_changed_at = v_now,
         provider_suppression_event_id = NULL,   -- clear the stale suppression Svix id (nothing suppresses now)
         last_event_type = 'operator_reset', last_event_at = v_now,
         reason = 'operator reset', updated_at = v_now
   WHERE email = v_email;
  -- internal event-log row recording the reset (resend_event_id NULL → not idempotency-scoped; each reset is distinct)
  INSERT INTO public.email_delivery_events (event_type, recipient_email, reason, occurred_at)
  VALUES ('operator_reset', v_email, 'operator reset', v_now);
END;
$$;
COMMENT ON FUNCTION public.reset_email_suppression(text) IS
  'INTERNAL service-role reset (NOT customer-facing): clears bounce + provider suppression for an address, stamps the recency clocks (so a stale callback cannot resurrect the old state), and writes an internal event-log row (traceability, not an immutable audit — the log is retention-swept). An authorized/audited operator wrapper (actor + tenant) is future work. service_role only.';
REVOKE ALL ON FUNCTION public.reset_email_suppression(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_email_suppression(text) TO service_role;
