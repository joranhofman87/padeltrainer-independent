-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- FINAL INTEGRATION AUDIT, ROUND 2 (P1) — the no-backlog contract measured the wrong clock.
--
-- N5 gates every send authority on `notification_outbox.created_at >= boundary_at`. That is the
-- instant the ROW was written, not the instant the EVENT happened, and the two only coincide while
-- every producer enqueues synchronously. NOTIFICATION_FOUNDATION.md said so out loud: a producer
-- that back-filled or replayed history after activation would write post-boundary rows for
-- pre-boundary events and the boundary would wave them through. A documented assumption is not an
-- enforced invariant, and "no historical backlog can become eligible after activation" is the one
-- promise this entire programme exists to keep.
--
-- So the clock moves. `occurred_at` is the producer's declaration of WHEN THE THING HAPPENED:
--
--   * immutable once written (owner-effective trigger, not merely an ACL), so a row cannot be
--     laundered into the present by an UPDATE;
--   * never in the future (CHECK + an explicit raise in the resolver), because a future stamp
--     would sail over every floor below it — that is the same laundering attack from the other
--     side;
--   * enforced at EVERY send authority — the instant claim (fresh and orphan-reclaim arms),
--     digest materialization (candidate and member scans), and the digest dispatch claim (scan and
--     the breaker's half-open probe). Not one door, all of them.
--
-- AND A SECOND FLOOR, because the boundary alone cannot help the path that matters most.
-- `email:instant` is seeded '-infinity' — deliberately, because it was already live when the
-- boundary system was built and no computed instant could be proven not to exclude mail already
-- queued. Against '-infinity' an occurrence gate is vacuous: a replay of a year of history would
-- still pass. `max_event_age_minutes` is the runtime mechanism that closes it — a per-path ceiling
-- on how old an event may be and still be sendable, so the effective floor is
-- `greatest(boundary_at, now() - max_event_age)`.
--
-- The floor is MONOTONE: it may be tightened, never loosened, and never removed. A ceiling that
-- can be raised is a window that can be widened to re-admit the history it excluded — exactly the
-- reasoning that made `boundary_at` immutable.
--
-- WHAT THIS CHANGES IN PRODUCTION, stated plainly: on the live `email:instant` path, a pending row
-- whose event is older than seven days stops being claimable. Nothing healthy is anywhere near
-- that (three synchronous producers, five attempts, minutes of backoff); what it catches is outage
-- debris, which must not be sent after an outage that long — that is the same conclusion
-- NOTIFICATION_OPERATIONS.md §5 already reached and `admin_dispose_stale_outbox` already exists to
-- act on. Blocked rows are not hidden: they stay pending, they are counted per path by
-- `admin_notification_activation_boundaries`, and postflight asserts on them.
--
-- WHAT THIS DOES NOT CLAIM. A producer that stamps `occurred_at = now()` for a year-old event is
-- indistinguishable from one reporting something that just happened, and no mechanism in a
-- database can tell them apart. What is enforced is that the declaration exists, is immutable, is
-- not in the future, and is checked at every door; what remains a producer's responsibility is
-- telling the truth in it. The call-site guard test makes every in-repo producer pass it
-- explicitly so the value is a decision rather than a default.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. the column ───────────────────────────────────────────────────────────────────────────
-- Backfilled from created_at rather than from a DEFAULT: for rows written before this migration
-- the enqueue instant IS the best available occurrence estimate, and a literal now() default would
-- have stamped every historical row with the deploy time — the exact lie this column exists to
-- prevent.
--
-- And there is deliberately NO column default. `DEFAULT now()` looks equivalent and is not: on any
-- INSERT that supplies its own created_at — a backfill, a repair script, half the fixtures in this
-- repo — it would stamp today's date on a row whose creation is dated last year, which is precisely
-- the incoherence this column exists to detect. The BEFORE INSERT trigger below fills it from the
-- row's OWN created_at instead, so "unspecified" means "whenever this row says it was written",
-- never "whenever the statement ran".
ALTER TABLE public.notification_outbox ADD COLUMN occurred_at timestamptz;
UPDATE public.notification_outbox SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE public.notification_outbox ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE public.notification_outbox ADD CONSTRAINT chk_notification_outbox_occurred_not_future
  CHECK (occurred_at <= created_at + interval '1 minute');
COMMENT ON COLUMN public.notification_outbox.occurred_at IS
  'When the EVENT this row reports actually happened, as declared by the producer — not when the row was written (created_at) and not when it should be sent (scheduled_for). Immutable, never in the future, and the value every activation boundary and event-age floor is measured against.';

-- the send authorities scan (channel, occurred_at) under a status filter; keep the boundary
-- predicate index-supported rather than turning every claim into a seq scan.
CREATE INDEX IF NOT EXISTS idx_outbox_occurrence_gate
  ON public.notification_outbox (channel, occurred_at)
  WHERE status IN ('pending', 'processing');

-- ── 2. occurred_at is filled from the row, then frozen ──────────────────────────────────────
-- A separate, tiny trigger rather than an edit to notification_outbox_snapshot_guard: that guard
-- is 90 lines of digest-identity rules and only runs its checks for digest rows, while this rule
-- is unconditional and belongs to every row. Two triggers on one event both have to pass.
CREATE OR REPLACE FUNCTION public.notif_outbox_occurrence_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_floor timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- the column default, expressed where it can see the row: unspecified occurrence means this
    -- row's own creation instant (already defaulted by now() when the caller did not supply one).
    IF NEW.occurred_at IS NULL THEN
      NEW.occurred_at := NEW.created_at;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'notification_outbox.occurred_at is immutable: moving it forward is how a historical event would be laundered past an activation boundary';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'notification_outbox.created_at is immutable';
  END IF;

  -- THE BACKSTOP. Every claim below already excludes pre-occurrence rows in its SELECT, which is
  -- what makes them passed over quietly instead of erroring. This exists for the claim that has
  -- not been written yet: a future send path that forgets the predicate gets a loud refusal at the
  -- mutation boundary rather than a silent historical send. It cannot fire for the paths that do
  -- carry the predicate — same transaction, same now(), same floor function.
  IF NEW.channel IN ('email', 'whatsapp')
     AND ((NEW.status = 'processing' AND OLD.status IS DISTINCT FROM 'processing')
       OR (NEW.digest_group_id IS NOT NULL AND OLD.digest_group_id IS NULL)) THEN
    v_floor := public.notif_activation_min_occurred_at(
      NEW.channel || (CASE WHEN NEW.delivery_mode = 'digest' THEN ':digest' ELSE ':instant' END));
    IF v_floor IS NULL OR NEW.occurred_at < v_floor THEN
      RAISE EXCEPTION 'notification_outbox %: refused to enter the send pipeline — its event occurred at % which is before the floor % for path %',
        NEW.id, NEW.occurred_at, v_floor,
        NEW.channel || (CASE WHEN NEW.delivery_mode = 'digest' THEN ':digest' ELSE ':instant' END);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_outbox_occurrence_guard ON public.notification_outbox;
CREATE TRIGGER trg_outbox_occurrence_guard BEFORE INSERT OR UPDATE ON public.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.notif_outbox_occurrence_guard();

-- ── 3. the per-path event-age ceiling ───────────────────────────────────────────────────────
ALTER TABLE public.notification_activation_boundaries ADD COLUMN max_event_age_minutes int;
ALTER TABLE public.notification_activation_boundaries
  ADD CONSTRAINT chk_activation_max_event_age
  CHECK (max_event_age_minutes IS NULL OR max_event_age_minutes BETWEEN 60 AND 525600);
COMMENT ON COLUMN public.notification_activation_boundaries.max_event_age_minutes IS
  'How old the underlying EVENT may be and still be sendable on this path. The effective floor is greatest(boundary_at, now() - this), which is what makes the no-backlog contract mean something on email:instant, whose boundary is -infinity. May only ever be tightened, never raised and never removed.';

-- The guard comes FIRST, so the seeding below is itself performed under the new rules rather than
-- sneaking in beneath the old ones. Two changes:
--
--   * the ceiling is monotone-tightening. NULL is the weakest possible value, so NULL -> a number
--     is allowed and a number -> NULL is not;
--   * an inert row may now be UPDATEd without activating. The old branch refused every update to
--     an inert path that did not open it, which was right when the only writable fields were the
--     activation's own — and would now forbid setting the ceiling on the two paths that have never
--     sent. Nothing leaks through: the coherence CHECK still requires boundary_at, request_id and
--     reason to be NULL while inert, so the ceiling and updated_at are the only fields an inert
--     row can move, and the transition itself is as one-way as it ever was.
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
    IF NEW.max_event_age_minutes IS DISTINCT FROM OLD.max_event_age_minutes
       AND (NEW.max_event_age_minutes IS NULL
            OR (OLD.max_event_age_minutes IS NOT NULL
                AND NEW.max_event_age_minutes > OLD.max_event_age_minutes)) THEN
      RAISE EXCEPTION 'notification_activation_boundaries: the event-age ceiling on % may only be tightened (% -> %) — raising or removing it re-admits exactly the history the floor excluded',
        OLD.path, OLD.max_event_age_minutes, NEW.max_event_age_minutes;
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
    ELSIF NEW.state IS DISTINCT FROM OLD.state AND NEW.state <> 'active' THEN
      RAISE EXCEPTION 'notification_activation_boundaries: the only transition is inert -> active';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

-- seven days on the instant paths: three synchronous producers with five attempts of backoff never
-- approach it, so what it excludes is outage debris. Thirty on digest, because a weekly digest's
-- oldest member is legitimately six days old when the group sends and a floor that tight would
-- start refusing correct work.
UPDATE public.notification_activation_boundaries SET max_event_age_minutes = 10080
 WHERE path IN ('email:instant', 'whatsapp:instant');
UPDATE public.notification_activation_boundaries SET max_event_age_minutes = 43200
 WHERE path = 'email:digest';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.notification_activation_boundaries WHERE max_event_age_minutes IS NULL) THEN
    RAISE EXCEPTION 'every delivery path must carry an event-age ceiling — an unbounded one on an -infinity boundary is no contract at all';
  END IF;
END $$;

-- ── 4. the reader every authority shares ────────────────────────────────────────────────────
-- NULL means the path may take NOTHING, exactly as notif_activation_boundary does — and because
-- `x >= NULL` is NULL rather than true, a caller that forgets to check still fails closed.
CREATE OR REPLACE FUNCTION public.notif_activation_min_occurred_at(p_path text)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT greatest(b.boundary_at,
                  CASE WHEN b.max_event_age_minutes IS NULL THEN NULL
                       ELSE now() - make_interval(mins => b.max_event_age_minutes) END)
    FROM public.notification_activation_boundaries b
   WHERE b.path = p_path AND b.state = 'active';
$$;
COMMENT ON FUNCTION public.notif_activation_min_occurred_at(text) IS
  'The oldest EVENT this path may still send: greatest(boundary_at, now() - max_event_age_minutes), or NULL when the path is inert (which every caller must treat as "take nothing"). greatest() ignores a NULL ceiling, so a path without one falls back to its boundary alone.';
REVOKE ALL ON FUNCTION public.notif_activation_min_occurred_at(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_activation_min_occurred_at(text) TO authenticated, service_role;

-- ── 5. the resolver declares it ─────────────────────────────────────────────────────────────
-- The 14-argument overload is DROPPED, not left beside the new one: two candidates differing only
-- by a defaulted trailing parameter make every named-argument call from the edge functions
-- ambiguous, which would fail at the first booking rather than at deploy.
DROP FUNCTION IF EXISTS public.enqueue_notification(
  text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz);

CREATE OR REPLACE FUNCTION public.enqueue_notification(
  p_event_key                 text,
  p_recipient_person_id       uuid        DEFAULT NULL,
  p_recipient_user_id         uuid        DEFAULT NULL,
  p_recipient_guest_player_id uuid        DEFAULT NULL,
  p_tenant_academy_profile_id uuid        DEFAULT NULL,
  p_tenant_trainer_id         uuid        DEFAULT NULL,
  p_idempotency_subject       text        DEFAULT NULL,
  p_related_booking_ids       uuid[]      DEFAULT NULL,
  p_related_invoice_id        uuid        DEFAULT NULL,
  p_related_payment_id        text        DEFAULT NULL,
  p_template_key              text        DEFAULT NULL,
  p_payload                   jsonb       DEFAULT '{}'::jsonb,
  p_public_summary            jsonb       DEFAULT NULL,
  p_scheduled_for             timestamptz DEFAULT NULL,
  -- AUDIT ROUND 2: WHEN THE THING HAPPENED, as distinct from when this row was written. Every
  -- producer in the closed inventory passes it explicitly (the call-site guard test enforces
  -- that); it defaults to now() only so a forgotten argument fails safe-and-current rather than
  -- silently ancient. It is immutable once written and may not be in the future.
  p_occurred_at               timestamptz DEFAULT NULL
) RETURNS TABLE (
  outbox_id              uuid,
  channel                text,
  status                 text,
  skip_reason            text,
  visibility_scope       text,
  destination_normalized text,
  destination_redacted   text,
  idempotency_key        text,
  collapse_key           text,
  recipient_person_id    uuid,
  public_summary         jsonb,
  template_key           text,
  scheduled_for          timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_evt              public.notification_event_types%ROWTYPE;
  v_emitted          uuid[] := '{}';
  v_row_id           uuid;
  v_person_id        uuid;
  v_user_id          uuid;
  v_guest_id         uuid := p_recipient_guest_player_id;
  v_subject          text;
  v_recipient_key    text;
  v_idem_key         text;
  v_now              timestamptz := now();
  v_occurred         timestamptz := coalesce(p_occurred_at, now());
  v_channel          text;
  v_supports         boolean;
  v_default_freq     text;
  v_freq             text;
  v_contact          public.notification_contacts%ROWTYPE;
  v_dest             text;
  v_dest_redacted    text;
  v_contact_id       uuid;
  v_deliverable      boolean;
  v_any_deliverable  boolean := false;
  v_email_skip       text;
  v_cap              text;   -- N3: the academy cap for (tenant, event, channel), if any
  v_cap_applied      boolean;  -- N3: true when the CAP (not the player) produced the final 'off'
  v_visibility       text;
  v_public_summary   jsonb;
  v_template         text;
  v_scheduled        timestamptz;
  v_collapse_key     text;
  -- 10c-b digest snapshot locals
  v_is_digest        boolean;
  v_status           text;
  v_skip             text;
  v_delivery_mode    text;
  v_digest_freq      text;
  v_tz               text;
  v_locale           text;
  v_boundary         timestamptz;
  v_item             jsonb;
  v_fingerprint      text;
  v_prefixed_key     text;
  v_tmpl_version     int;
  v_payload_out      jsonb;
BEGIN
  -- occurred_at is a PAST tense. A future stamp would sail over every occurrence floor below
  -- it, so the one way to launder a historical event into a current one is refused here and by
  -- the table's CHECK constraint (this raise exists to say WHY, not to be the only guard).
  IF v_occurred > v_now + interval '1 minute' THEN
    RAISE EXCEPTION 'enqueue_notification: p_occurred_at % is in the future — it records when the event happened, not when the message should be sent (use p_scheduled_for for that)', v_occurred;
  END IF;
  -- 1. resolve the event type (config drives every downstream decision)
  SELECT * INTO v_evt FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_notification: unknown event_type %', p_event_key;
  END IF;

  -- 2. a recipient is mandatory
  IF p_recipient_person_id IS NULL AND p_recipient_user_id IS NULL AND p_recipient_guest_player_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_notification: no recipient (person/user/guest all null) for %', p_event_key;
  END IF;

  -- 3. normalize to the one person across the dual-key transition
  v_person_id := p_recipient_person_id;
  IF v_person_id IS NULL AND p_recipient_user_id IS NOT NULL THEN
    SELECT id INTO v_person_id FROM public.persons WHERE user_id = p_recipient_user_id;
  END IF;
  IF v_person_id IS NULL AND v_guest_id IS NOT NULL THEN
    SELECT person_id INTO v_person_id FROM public.person_links WHERE guest_player_id = v_guest_id;
  END IF;
  v_user_id := p_recipient_user_id;
  IF v_user_id IS NULL AND v_person_id IS NOT NULL THEN
    SELECT user_id INTO v_user_id FROM public.persons WHERE id = v_person_id;
  END IF;

  -- 4. PER-RECIPIENT idempotency key
  v_subject := nullif(btrim(coalesce(p_idempotency_subject, '')), '');
  IF v_subject IS NULL THEN
    v_subject := CASE
      WHEN p_related_invoice_id IS NOT NULL THEN 'invoice:' || p_related_invoice_id::text
      WHEN p_related_payment_id IS NOT NULL THEN 'payment:' || p_related_payment_id
      WHEN p_related_booking_ids IS NOT NULL AND array_length(p_related_booking_ids, 1) > 0
        THEN 'bookings:' || (SELECT string_agg(b::text, ',' ORDER BY b) FROM unnest(p_related_booking_ids) AS b)
      ELSE NULL
    END;
  END IF;
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'enqueue_notification: % needs an idempotency subject (pass p_idempotency_subject, or a related invoice/payment/booking ref to derive one)', p_event_key;
  END IF;
  v_recipient_key := coalesce(v_person_id::text, v_guest_id::text, p_recipient_user_id::text);
  v_idem_key := p_event_key || ':' || v_subject || ':' || v_recipient_key;

  -- 5. tenant-visibility contract
  v_visibility := v_evt.visibility_scope;
  IF v_visibility IN ('tenant_visible', 'tenant_visible_limited') THEN
    IF p_tenant_academy_profile_id IS NULL AND p_tenant_trainer_id IS NULL THEN
      RAISE EXCEPTION 'enqueue_notification: % is %, but no tenant context was supplied', p_event_key, v_visibility;
    END IF;
    v_public_summary := coalesce(p_public_summary, jsonb_build_object('event_type', p_event_key));
  ELSE
    v_public_summary := p_public_summary;
  END IF;

  -- 6. resolve + enqueue per supported channel
  FOREACH v_channel IN ARRAY ARRAY['email', 'whatsapp', 'push'] LOOP
    v_supports := CASE v_channel
      WHEN 'email'    THEN v_evt.supports_email
      WHEN 'whatsapp' THEN v_evt.supports_whatsapp
      WHEN 'push'     THEN v_evt.supports_push
    END;
    CONTINUE WHEN NOT v_supports;

    -- 6a. preference frequency: prefs_v2 override (needs a login) else event default
    v_default_freq := CASE v_channel
      WHEN 'email'    THEN v_evt.default_email_frequency
      WHEN 'whatsapp' THEN v_evt.default_whatsapp_frequency
      WHEN 'push'     THEN v_evt.default_push_frequency
    END;
    v_freq := NULL;
    IF v_user_id IS NOT NULL THEN
      SELECT CASE v_channel
        WHEN 'email'    THEN email_frequency
        WHEN 'whatsapp' THEN whatsapp_frequency
        WHEN 'push'     THEN push_frequency
      END INTO v_freq
      FROM public.notification_preferences_v2
      WHERE user_id = v_user_id AND event_type = p_event_key;
    END IF;
    -- WHATSAPP: AN EXPLICIT BOOKING OPT-IN *IS* THE OPT-IN. (Preserved verbatim from
    -- 20260922100000 — the TRUE pre-C baseline of this function. prefs_v2 is user_id-keyed, so
    -- a GUEST can never express a cadence and would stay pinned to the 'off' default forever;
    -- and a logged-in player has no WhatsApp control on required_delivery events. So when the
    -- person has expressed NO preference, an opted-in IN-SCOPE contact supplies the cadence,
    -- but only for events flagged whatsapp_optin_via_booking. An EXPLICIT preference still
    -- wins, INCLUDING 'off'.)
    IF v_channel = 'whatsapp'
       AND v_freq IS NULL
       AND v_evt.whatsapp_optin_via_booking
       AND public.whatsapp_optin_in_scope(
             v_person_id, v_user_id, v_guest_id,
             p_tenant_academy_profile_id, p_tenant_trainer_id) THEN
      v_freq := 'instant';
    END IF;

    v_freq := coalesce(v_freq, v_default_freq);

    -- 6a-N3. THE ACADEMY CAP — most-restrictive-wins, NEVER a floor (design contract, thread
    -- 019fd175). Applied ONLY to optional events (a required event is untouchable by tenants —
    -- refused at write by M2's trigger AND ignored here, belt and braces), ONLY to
    -- academy-attributed sends (a trainer-only or global send has no academy to answer to; the
    -- attribution matrix documents which events those are), and ONLY when it is stricter than
    -- what the player already chose: a player's own 'off' stays their own decision with their
    -- own skip reason, and a player's 'weekly' under a 'daily' cap stays 'weekly'.
    v_cap_applied := false;
    IF NOT v_evt.required_delivery AND p_tenant_academy_profile_id IS NOT NULL AND v_freq <> 'off' THEN
      SELECT r.max_frequency INTO v_cap
        FROM public.academy_notification_restrictions r
       WHERE r.academy_profile_id = p_tenant_academy_profile_id
         AND r.event_type = p_event_key AND r.channel = v_channel;
      IF FOUND AND public.notif_frequency_rank(v_cap) > public.notif_frequency_rank(v_freq) THEN
        v_freq := v_cap;
        v_cap_applied := (v_freq = 'off');
      END IF;
    END IF;

    -- 6b. required delivery guarantees the EMAIL channel: it can't be off or digested.
    -- RUNS LAST by contract (finding 7): even a stale cap row surviving a catalog flip to
    -- required cannot weaken required email.
    IF v_evt.required_delivery AND v_channel = 'email' THEN
      v_freq := 'instant';
    END IF;

    IF v_freq = 'off' THEN
      IF v_cap_applied THEN
        -- FINDING 11: a cap-caused 'off' is a TENANT decision and must be visible as one — a
        -- terminal skipped row, written BEFORE contact resolution (no destination is ever
        -- resolved for it), tenant-attributed, carrying only the safe public summary. Distinct
        -- from 'preference_off' so observability and the audit trail stay honest about WHO
        -- silenced the send. The row consumes this send's (channel, idem, tenant) slot: the
        -- decision is evidence, and a later re-invocation of the SAME send does not resurrect
        -- it — a new send (new subject) enqueues normally.
        INSERT INTO public.notification_outbox (
          event_type, channel, occurred_at,
          recipient_user_id, recipient_person_id, recipient_guest_player_id,
          tenant_academy_profile_id, tenant_trainer_id, visibility_scope,
          related_booking_ids, related_invoice_id, related_payment_id,
          payload, public_summary,
          idempotency_key, status, skip_reason, scheduled_for
        ) VALUES (
          p_event_key, v_channel, v_occurred,
          v_user_id, v_person_id, v_guest_id,
          p_tenant_academy_profile_id, p_tenant_trainer_id, v_visibility,
          p_related_booking_ids, p_related_invoice_id, p_related_payment_id,
          -- NO payload retention: this send was refused before rendering or contact resolution
          -- ever ran, and evidence of a refusal needs no content — only the safe summary.
          '{}'::jsonb, v_public_summary,
          v_idem_key, 'skipped', 'tenant_restricted', v_now
        )
        ON CONFLICT (channel, idempotency_key, tenant_scope_key) DO NOTHING
        RETURNING id INTO v_row_id;
        IF FOUND THEN v_emitted := array_append(v_emitted, v_row_id); END IF;
      ELSIF v_channel = 'email' THEN
        v_email_skip := 'preference_off';
      END IF;
      CONTINUE;
    END IF;

    -- 6c. destination + consent
    v_deliverable := false; v_dest := NULL; v_dest_redacted := NULL; v_contact_id := NULL;

    IF v_channel = 'email' THEN
      SELECT * INTO v_contact FROM public.notification_contacts
      WHERE channel = 'email' AND revoked_at IS NULL AND consent_status <> 'opted_out'
        AND (consent_scope <> 'global' OR v_user_id IS NOT NULL)
        AND public.is_notification_consent_in_scope(
              consent_scope, consent_academy_profile_id, consent_trainer_id,
              p_tenant_academy_profile_id, p_tenant_trainer_id)
        AND ( (v_person_id IS NOT NULL AND person_id = v_person_id)
           OR (v_user_id   IS NOT NULL AND user_id = v_user_id)
           OR (v_guest_id  IS NOT NULL AND guest_player_id = v_guest_id) )
      ORDER BY is_primary DESC, verified_at DESC NULLS LAST
      LIMIT 1;
      IF FOUND THEN
        v_dest := v_contact.destination_normalized;
        v_dest_redacted := v_contact.destination_redacted;
        v_contact_id := v_contact.id;
      ELSIF v_user_id IS NOT NULL THEN
        SELECT email INTO v_dest FROM public.persons WHERE id = v_person_id;
        v_dest_redacted := public.notification_redact_destination(v_dest, 'email');
      END IF;

      IF v_dest IS NULL OR btrim(v_dest) = '' THEN
        v_email_skip := coalesce(v_email_skip, 'no_email_contact');
      ELSIF public.is_email_suppressed(v_dest) THEN
        v_email_skip := 'email_suppressed';
      -- N6 FINAL AUDIT, the N2<->N3 seam: MARKETING mail must honour the one-click unsubscribe.
      -- N2 declares which events carry an unsubscribe footer (email_footer_policy) and records the
      -- result in email_marketing_suppression; the resolver never read it, so a marketing event
      -- enqueued through this path would have promised an unsubscribe in its own footer and then
      -- ignored it. Scope-aware: a platform suppression silences everything, an academy one
      -- silences that academy's sends. (Trainer-attributed marketing has no scope of its own here —
      -- the platform arm still covers it, and a trainer-scoped suppression is checked when the send
      -- is trainer-attributed.)
      ELSIF v_evt.email_footer_policy = 'marketing_unsubscribe'
            AND (
              public.is_marketing_suppressed(v_dest, 'platform', NULL)
              OR (p_tenant_academy_profile_id IS NOT NULL
                  AND public.is_marketing_suppressed(v_dest, 'academy', p_tenant_academy_profile_id))
              OR (p_tenant_trainer_id IS NOT NULL
                  AND public.is_marketing_suppressed(v_dest, 'trainer', p_tenant_trainer_id))
            ) THEN
        v_email_skip := 'marketing_unsubscribed';
      ELSE
        v_deliverable := true;
      END IF;

    ELSE
      SELECT * INTO v_contact FROM public.notification_contacts
      WHERE channel = v_channel AND revoked_at IS NULL AND consent_status = 'opted_in'
        AND (consent_scope <> 'global' OR v_user_id IS NOT NULL)
        AND public.is_notification_consent_in_scope(
              consent_scope, consent_academy_profile_id, consent_trainer_id,
              p_tenant_academy_profile_id, p_tenant_trainer_id)
        AND ( (v_person_id IS NOT NULL AND person_id = v_person_id)
           OR (v_user_id   IS NOT NULL AND user_id = v_user_id)
           OR (v_guest_id  IS NOT NULL AND guest_player_id = v_guest_id) )
      ORDER BY is_primary DESC, verified_at DESC NULLS LAST
      LIMIT 1;
      IF FOUND THEN
        v_dest := v_contact.destination_normalized;
        v_dest_redacted := v_contact.destination_redacted;
        v_contact_id := v_contact.id;
        v_deliverable := true;
      END IF;
    END IF;

    CONTINUE WHEN NOT v_deliverable;

    -- 6d. DELIVERY MODE (10c-b). Reset every iteration — a stale digest snapshot leaking
    --     onto the next channel's row would mint a bogus group identity.
    v_is_digest := false; v_status := 'pending'; v_skip := NULL;
    v_delivery_mode := NULL; v_digest_freq := NULL; v_tz := NULL; v_locale := NULL;
    v_boundary := NULL; v_item := NULL; v_fingerprint := NULL; v_prefixed_key := NULL;
    v_tmpl_version := NULL; v_payload_out := coalesce(p_payload, '{}'::jsonb);

    -- FREEZE THE DESTINATION FINGERPRINT ON EVERY EMAIL ROW, not just digest members.
    -- The live-send policy (notif_digest_member_stop_reason) refuses to send when the CURRENT
    -- contact no longer fingerprints to the frozen value — but that check is written
    -- `IF destination_fingerprint IS NOT NULL`, so a NULL silently disables it. Instant rows
    -- previously had NULL here, which meant the worker would happily deliver to the frozen OLD
    -- address after a user changed their email. Freezing it for instant rows too is what makes
    -- the destination_changed stop reachable on that path.
    IF v_channel = 'email' AND v_dest IS NOT NULL THEN
      v_fingerprint := public.notif_digest_destination_fingerprint(v_dest);
    END IF;

    IF v_channel = 'email' AND v_evt.digest_cutover AND v_freq IN ('daily','weekly') THEN
      IF v_evt.digest_engine_enabled THEN
        -- A real digest member. Every canonical grouping input is frozen HERE; the item
        -- is minted by trusted SQL from structured payload fields (never edge-rendered).
        v_is_digest     := true;
        v_delivery_mode := 'digest';
        v_digest_freq   := v_freq;
        v_tz            := public.notif_digest_recipient_timezone(p_tenant_academy_profile_id, p_tenant_trainer_id);
        v_locale        := public.notif_digest_group_locale(v_person_id, v_user_id);
        v_boundary      := public.notif_digest_boundary_at(v_now, v_freq, v_tz);
        v_item          := public.notif_digest_item_for_event(p_event_key, v_locale, coalesce(p_payload, '{}'::jsonb));
        v_tmpl_version  := v_evt.template_version;   -- fingerprint already frozen above
        -- ADR §M1 prefixed recipient key: person is the stable identity, then account, then guest.
        v_prefixed_key  := CASE
          WHEN v_person_id IS NOT NULL THEN 'p:' || v_person_id::text
          WHEN v_user_id   IS NOT NULL THEN 'u:' || v_user_id::text
          ELSE 'g:' || v_guest_id::text
        END;
      ELSE
        -- Engine OFF. An explicit, auditable, INERT outcome: not a digest row (no
        -- delivery_mode → the materializer cannot see it), not pending (the instant
        -- worker cannot see it), not scheduled into the future (nothing to burst).
        v_status := 'skipped';
        v_skip   := 'digest_engine_disabled';
      END IF;
    END IF;

    -- A cutover event on an INSTANT cadence still needs SERVER-RENDERED content. The instant
    -- worker reads payload.subject/payload.html and treats a row that cannot render as TERMINAL,
    -- so without this an instant open-slots alert would be reported as enqueued and then
    -- silently terminal-failed — with its idempotency key then blocking every retry. Slice C's
    -- backfill carries a legacy `instant` choice across verbatim, so this cadence is live.
    -- The copy comes from the SAME trusted item builder the digest uses, so the two routes say
    -- the same thing and the edge function still supplies nothing a recipient can read.
    IF v_channel = 'email' AND v_evt.digest_cutover AND v_freq = 'instant' THEN
      v_locale      := public.notif_digest_group_locale(v_person_id, v_user_id);
      v_item        := public.notif_digest_item_for_event(p_event_key, v_locale, coalesce(p_payload, '{}'::jsonb));
      v_payload_out := v_payload_out || public.notif_open_slots_instant_payload(v_item);
      v_item        := NULL;   -- instant rows carry no digest snapshot
    END IF;

    -- 6e. scheduling. The legacy daily/weekly delayed-instant branch below is UNCHANGED
    --     and still governs every non-cutover event.
    v_scheduled := CASE
      WHEN v_is_digest          THEN v_boundary
      WHEN v_status = 'skipped' THEN v_now
      WHEN v_freq = 'daily'     THEN date_trunc('day',  v_now) + interval '1 day'  + interval '8 hours'
      WHEN v_freq = 'weekly'    THEN date_trunc('week', v_now) + interval '7 days' + interval '8 hours'
      ELSE coalesce(p_scheduled_for, v_now)
    END;

    -- collapse window: pending rows sharing this key are worker-collapsed into one send.
    v_collapse_key := NULL;
    IF v_evt.collapse_window_minutes > 0 THEN
      v_collapse_key := p_event_key || ':' || v_channel || ':' || v_recipient_key || ':'
        || floor(extract(epoch FROM v_now) / (v_evt.collapse_window_minutes * 60))::text;
    END IF;

    v_template := coalesce(p_template_key, CASE v_channel
      WHEN 'email'    THEN v_evt.template_email
      WHEN 'whatsapp' THEN v_evt.template_whatsapp
      ELSE NULL END);

    INSERT INTO public.notification_outbox (
      event_type, channel, occurred_at,
      recipient_user_id, recipient_person_id, recipient_guest_player_id,
      tenant_academy_profile_id, tenant_trainer_id, visibility_scope,
      related_booking_ids, related_invoice_id, related_payment_id,
      destination_normalized, destination_redacted, contact_id,
      template_key, payload, public_summary,
      idempotency_key, collapse_key, status, skip_reason, scheduled_for,
      delivery_mode, recipient_key, digest_frequency, group_locale, recipient_timezone,
      digest_boundary_at, template_version, destination_fingerprint, digest_item
    ) VALUES (
      p_event_key, v_channel, v_occurred,
      v_user_id, v_person_id, v_guest_id,
      p_tenant_academy_profile_id, p_tenant_trainer_id, v_visibility,
      p_related_booking_ids, p_related_invoice_id, p_related_payment_id,
      v_dest, v_dest_redacted, v_contact_id,
      v_template, v_payload_out, v_public_summary,
      v_idem_key, v_collapse_key, v_status, v_skip, v_scheduled,
      v_delivery_mode, v_prefixed_key, v_digest_freq, v_locale, v_tz,
      v_boundary, v_tmpl_version, v_fingerprint, v_item
    )
    ON CONFLICT (channel, idempotency_key, tenant_scope_key) DO NOTHING
    RETURNING id INTO v_row_id;

    IF FOUND THEN
      v_emitted := array_append(v_emitted, v_row_id);
    END IF;
    v_any_deliverable := true;
  END LOOP;

  -- 7. required delivery but nothing was deliverable → a VISIBLE skipped row
  IF NOT v_any_deliverable AND v_evt.required_delivery THEN
    INSERT INTO public.notification_outbox (
      event_type, channel, occurred_at,
      recipient_user_id, recipient_person_id, recipient_guest_player_id,
      tenant_academy_profile_id, tenant_trainer_id, visibility_scope,
      related_booking_ids, related_invoice_id, related_payment_id,
      payload, public_summary,
      idempotency_key, status, skip_reason, scheduled_for
    ) VALUES (
      p_event_key, 'email', v_occurred,
      v_user_id, v_person_id, v_guest_id,
      p_tenant_academy_profile_id, p_tenant_trainer_id, v_visibility,
      p_related_booking_ids, p_related_invoice_id, p_related_payment_id,
      coalesce(p_payload, '{}'::jsonb), v_public_summary,
      v_idem_key, 'skipped', coalesce(v_email_skip, 'no_deliverable_channel'), v_now
    )
    ON CONFLICT (channel, idempotency_key, tenant_scope_key) DO NOTHING
    RETURNING id INTO v_row_id;
    IF FOUND THEN
      v_emitted := array_append(v_emitted, v_row_id);
    END IF;
  END IF;

  RETURN QUERY
    SELECT o.id, o.channel, o.status, o.skip_reason, o.visibility_scope,
           o.destination_normalized, o.destination_redacted, o.idempotency_key,
           o.collapse_key, o.recipient_person_id, o.public_summary, o.template_key, o.scheduled_for
    FROM public.notification_outbox o
    WHERE o.id = ANY(v_emitted)
    ORDER BY o.channel;
  RETURN;
END;
$$;
COMMENT ON FUNCTION public.enqueue_notification(
  text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz, timestamptz) IS
  'The resolver: one intent in, one row per deliverable channel out, with preference/consent/suppression/cap decisions made here and recorded as skip reasons. p_occurred_at declares when the underlying event happened (defaulting to now()); it is stamped immutably on every row and is what the activation boundary and the event-age floor are measured against.';
REVOKE ALL ON FUNCTION public.enqueue_notification(
  text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_notification(
  text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz, timestamptz) TO authenticated, service_role;

-- ── 6. the send authorities, recreated with the occurrence floor ────────────────────────────
-- Each is lifted verbatim from its newest definition; the ONLY differences are the v_min_occurred
-- declaration, its assignment beside the existing boundary read, and the predicate added beside
-- the existing created_at one. Both predicates are kept: created_at is the indexed one and the
-- pair is what makes a row eligible.

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
DECLARE v_boundary timestamptz; v_min_occurred timestamptz;
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
  -- AUDIT ROUND 2: the OCCURRENCE floor. created_at says when the row was written; occurred_at
  -- says when the thing it reports happened. A replay writes fresh rows for ancient events, so
  -- created_at alone cannot see it. NULL here is impossible for an active path, and would fail
  -- closed anyway (x >= NULL is NULL, i.e. not true).
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

CREATE OR REPLACE FUNCTION public.materialize_notification_digest_groups(
    p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int, p_max_members_per_call int)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget int := 92160;                 -- ~90 KB cumulative byte budget per group
  v_groups int := 0; v_members int := 0; v_iter int := 0; v_lock_skips int := 0;
  cand record; m record;
  v_ckey jsonb; v_hash text; v_group uuid; v_count int; v_bytes int; v_next_chunk int; v_n int;
  v_boundary timestamptz; v_min_occurred timestamptz;
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
  -- AUDIT ROUND 2: the OCCURRENCE floor, on both scans below for the same reason the created_at
  -- boundary is on both — a member sharing a legitimate row's key arrives one hop later.
  v_min_occurred := public.notif_activation_min_occurred_at(p_channel || ':digest');

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
       AND o.occurred_at >= v_min_occurred      -- audit: pre-OCCURRENCE rows never enter it either
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
         AND o.occurred_at >= v_min_occurred
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

CREATE OR REPLACE FUNCTION public.claim_notification_digest_group(
    p_run_id uuid, p_channel text, p_now timestamptz, p_worker text, p_stale_minutes int DEFAULT 15)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_iter int := 0; v_bump timestamptz; v_cb record; v_promote boolean := false; v_n int;
        v_boundary timestamptz; v_min_occurred timestamptz;
BEGIN
  -- N4 M2 KILL SWITCH — FIRST. NULL is this function's own idle answer, so a killed channel
  -- reads as "no group due" and the worker ends the loop without touching the ledger. Shares
  -- the kill-set's per-channel advisory lock (no mid-claim interleave).
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN NULL;
  END IF;

  -- N5 (round 2) NO-BACKLOG BOUNDARY. Materialization gates where a row ENTERS the digest path,
  -- which is enough for every group formed from here on — but a group that already exists carries
  -- its members' history with it, and this claim is the single door every send goes through
  -- (prepare/split/oversize/send all require the ownership this stamps). An inert path therefore
  -- dispatches nothing at all, and a group holding ANY pre-boundary member is passed over below.
  v_boundary := public.notif_activation_boundary(p_channel || ':digest');
  IF v_boundary IS NULL THEN
    RETURN NULL;
  END IF;
  -- AUDIT ROUND 2: the OCCURRENCE floor. A group is delivered WHOLE, so one pre-occurrence member
  -- disqualifies the group — on the scan and on the breaker's probe alike.
  v_min_occurred := public.notif_activation_min_occurred_at(p_channel || ':digest');

  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', p_channel);
  PERFORM notif_digest_require_range(p_stale_minutes, 1, 1440, 'claim: p_stale_minutes');

  -- breaker preflight (one read; lock only when the state machine must move).
  SELECT * INTO v_cb FROM public.notification_provider_circuit WHERE channel = p_channel;
  IF FOUND AND v_cb.state = 'open' THEN
    IF v_cb.retry_at IS NULL OR p_now < v_cb.retry_at THEN RETURN NULL; END IF;  -- held / not due: no scan
    v_promote := true;                                       -- due → first claimable group becomes the probe
  ELSIF FOUND AND v_cb.state = 'half_open' THEN
    IF v_cb.probe_locked_at IS NOT NULL AND v_cb.probe_locked_at < p_now - make_interval(mins => p_stale_minutes) THEN
      -- stale probe lease (crash before/after HTTP) → re-arm under the row lock, then promote a fresh probe.
      UPDATE public.notification_provider_circuit SET state = 'open', probe_group_id = NULL,
             probe_attempt_id = NULL, probe_locked_at = NULL, retry_at = p_now
       WHERE channel = p_channel AND state = 'half_open'
         AND probe_locked_at IS NOT NULL AND probe_locked_at < p_now - make_interval(mins => p_stale_minutes);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN v_promote := true; ELSE RETURN NULL; END IF;   -- someone else moved it → back off
    ELSIF v_cb.probe_group_id IS NOT NULL THEN
      -- only the bound probe is claimable; everything else waits (untouched — no deferral writes).
      SELECT * INTO g FROM public.notification_digest_groups dg
       WHERE dg.id = v_cb.probe_group_id AND dg.channel = p_channel
         AND dg.state = 'request_ready' AND dg.locked_by IS NULL AND dg.available_at <= p_now
         -- N5 (round 3): the probe is the ONE claim that does not come from the scan below, so it
         -- needs the boundary check of its own. A pre-boundary group promoted to probe before this
         -- contract existed would otherwise be handed ownership and sent — as the breaker's own
         -- half-open probe, i.e. the single most privileged send in the system.
         AND NOT EXISTS (SELECT 1 FROM public.notification_outbox o
                          WHERE o.digest_group_id = dg.id
                            AND (o.created_at < v_boundary OR o.occurred_at < v_min_occurred))
       FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN RETURN NULL; END IF;
      UPDATE public.notification_digest_groups
         SET locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
       WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
      RETURN g.id;
    ELSE
      RETURN NULL;                                           -- half_open with no probe yet bound elsewhere
    END IF;
  END IF;

  LOOP  -- circuit closed, or open+due (v_promote): scan for work
    v_iter := v_iter + 1;
    IF v_iter > 200 THEN RETURN NULL; END IF;   -- hard scan bound (never unbounded)
    SELECT * INTO g FROM public.notification_digest_groups dg
     WHERE dg.channel = p_channel
       -- N5 (round 2): a group holding ANY member created before this path's boundary can never
       -- be sent — the boundary excludes those events and a group is delivered whole. It is
       -- excluded from the SCAN, not skipped after selection: SKIP LOCKED does not skip rows this
       -- transaction itself holds, so a post-selection CONTINUE would re-pick the same row until
       -- the iteration cap and starve every group behind it. Passed over rather than
       -- terminalized — deciding the fate of historical work is an operator's act (the readiness
       -- envelope counts these; the disposal is the sanctioned exit), never something a dispatch
       -- claim does on its way past.
       AND NOT EXISTS (SELECT 1 FROM public.notification_outbox o
                        WHERE o.digest_group_id = dg.id
                          AND (o.created_at < v_boundary OR o.occurred_at < v_min_occurred))
       AND ( (state IN ('pending','request_ready') AND locked_by IS NULL AND available_at <= p_now)
          OR (state = 'awaiting_evidence' AND available_at <= p_now)
          OR (state IN ('leased','prepared','request_ready','sending')
              AND locked_at IS NOT NULL AND locked_at < p_now - make_interval(mins => p_stale_minutes)) )
     ORDER BY available_at
     FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- uncertainty age-out — ANY due uncertain group (request_ready | sending | awaiting_evidence), handled
    -- BEFORE the quiet-hours/breaker deferral branches. Otherwise a group whose deadline is already past
    -- would be deferred to least(bump, deadline) = the already-due deadline, re-selected, and hot-loop until
    -- the v_iter cap (one call emitting 200 'deferred' ledger rows). Finalize delivery_unknown, commit
    -- reservations, write exactly ONE outcome ledger event, and continue.
    IF g.uncertain_since IS NOT NULL AND g.uncertain_deadline_at IS NOT NULL AND p_now >= g.uncertain_deadline_at THEN
      PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'age_out', p_now);
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
      CONTINUE;
    END IF;

    -- crash reclaim of a stale-locked group.
    IF g.locked_at IS NOT NULL AND g.locked_at < p_now - make_interval(mins => p_stale_minutes)
       AND g.state IN ('leased','prepared','request_ready','sending') THEN
      IF g.state = 'sending' THEN
        -- the uncertainty window is anchored to the FIRST HTTP dispatch (the frozen idempotency key's
        -- provider-side dedup window starts there, not at crash discovery). Late discovery — at/after
        -- first_send_at + 23h — must finalize delivery_unknown, never become sendable again: a re-POST
        -- outside the provider window would DUPLICATE delivery.
        IF p_now >= notif_digest_uncertainty_deadline(g.first_send_at, g.uncertain_deadline_at) THEN
          PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'uncertain_age_out', p_now);
          PERFORM notif_digest_commit_reservations(g.id, p_now);
          PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
          CONTINUE;
        END IF;
        UPDATE public.notification_digest_groups
           SET uncertain_since = coalesce(uncertain_since, p_now),
               uncertain_deadline_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
               state = 'request_ready',
               locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, available_at = p_now, updated_at = p_now
         WHERE id = g.id;
      ELSE
        UPDATE public.notification_digest_groups
           SET locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
         WHERE id = g.id;
      END IF;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
      RETURN g.id;
    END IF;

    -- quiet hours: bump available_at (a genuine SCHEDULING change), do not claim — capped at the uncertainty
    -- deadline (an uncertain group must never be scheduled past first_send_at + 23h).
    v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
    IF v_bump > p_now THEN
      UPDATE public.notification_digest_groups
         SET available_at = least(v_bump, coalesce(g.uncertain_deadline_at, 'infinity'::timestamptz)), updated_at = p_now
       WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'deferred', 0);
      CONTINUE;
    END IF;

    -- open+due: promote THIS candidate to the probe — CAS under the circuit row lock, re-validated.
    IF v_promote THEN
      UPDATE public.notification_provider_circuit
         SET state = 'half_open', probe_group_id = g.id, probe_attempt_id = NULL, probe_locked_at = p_now
       WHERE channel = p_channel AND state = 'open' AND (retry_at IS NOT NULL AND p_now >= retry_at);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RETURN NULL; END IF;   -- another worker promoted/re-tripped first → back off, no writes
      v_promote := false;
    END IF;

    -- claimable: lease it.
    UPDATE public.notification_digest_groups
       SET state = CASE WHEN g.state = 'pending' THEN 'leased' ELSE g.state END,
           locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
     WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
    RETURN g.id;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.claim_notification_outbox_batch(text, text, int, int) IS
  'The instant worker''s atomic claim. Gates, in order: the channel KILL switch, then the N5 ACTIVATION BOUNDARY and the audit OCCURRENCE FLOOR (inert path = claim nothing; active path = only rows created at or after boundary_at whose EVENT occurred at or after greatest(boundary_at, now() - max_event_age) — on the fresh AND the orphan-reclaim arm). Then the live academy-cap cancel, the stale reap, and the FOR UPDATE SKIP LOCKED claim.';
COMMENT ON FUNCTION public.materialize_notification_digest_groups(uuid, text, timestamptz, int, int) IS
  'Forms digest groups from pending members. Gated by the channel kill switch, the activation boundary and the occurrence floor — on the candidate scan AND the per-key member scan, so a pre-boundary or pre-occurrence row can neither start a group nor be swept into one that a legitimate row started.';
COMMENT ON FUNCTION public.claim_notification_digest_group(uuid, text, timestamptz, text, int) IS
  'The single door every digest send goes through. An inert path claims nothing; an active one passes over any group holding a member created before the boundary or whose event occurred before the floor — on the ordinary scan and on the breaker''s half-open probe, which is the one claim that does not come from that scan.';

-- ── 7. the two IN-DATABASE producers declare it too ─────────────────────────────────────────
-- Both are synchronous with their event today — one is an AFTER INSERT trigger, the other is
-- called from the booking write. Declaring the occurrence explicitly is what keeps that true: the
-- day either moves behind a queue or a retry, the row still carries the instant the booking or the
-- review actually happened, and the floor still refuses it if that instant is too old.
-- Lifted verbatim from their newest definitions; the only differences are the derivation, its
-- refusal when there is nothing to derive from, and the argument.

CREATE OR REPLACE FUNCTION public.notify_review_received()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_html    text;
BEGIN
  -- SECURITY: only notify for a review tied to a REAL booking of THIS player with THIS
  -- trainer. The reviews INSERT RLS only checks player_id, and booking_id has no FK, so
  -- without this a caller could insert reviews with a forged trainer_id + random booking_id
  -- and make the platform email spam to arbitrary trainers. Verify the player↔trainer link
  -- through the booking's slot; if it doesn't hold, keep the review row but send nothing.
  IF NOT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE b.id = NEW.booking_id
      AND b.player_id = NEW.player_id
      AND s.trainer_id = NEW.trainer_id
      AND b.status IN ('completed', 'confirmed')
  ) THEN
    RETURN NEW;
  END IF;

  -- recipient = the reviewed trainer (trainer_profiles.user_id is NOT NULL → always a login)
  SELECT user_id INTO v_user_id FROM public.trainer_profiles WHERE id = NEW.trainer_id;
  IF v_user_id IS NULL THEN
    RETURN NEW;  -- no resolvable recipient → nothing to enqueue
  END IF;

  -- Minimal, injection-safe email (mirrors the legacy send-email template's spirit):
  -- rating only, NO user-controlled free text (reviewer name / comment). The trainer
  -- sees the full review in-app; richer (escaped) content is a later enhancement.
  v_html :=
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">'
    || '<h1 style="color: #f59e0b;">New Review! &#11088;</h1>'
    || '<p>You have received a new ' || NEW.rating::text || '-star review!</p>'
    || '<div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">'
    || '<p><strong>Rating:</strong> ' || repeat('&#11088;', NEW.rating) || '</p>'
    || '</div>'
    || '<p>Keep up the great work! View the full review in your dashboard.</p>'
    || '<p>Best regards,<br>PadelTrainer.ai Team</p>'
    || '</div>';

  -- Enqueue via the resolver. Never let a notification failure break the review insert.
  BEGIN
    PERFORM public.enqueue_notification(
      p_event_key           => 'review_received_trainer',
      p_recipient_user_id   => v_user_id,
      p_tenant_trainer_id   => NEW.trainer_id,             -- required: event is tenant_visible
      p_idempotency_subject => NEW.id::text,               -- one notification per review
      -- the review row's own timestamp: this is an AFTER INSERT trigger, so the event and the
      -- enqueue are the same instant — declared rather than assumed, so it stays true if this
      -- ever moves behind a queue.
      p_occurred_at         => coalesce(NEW.created_at, now()),
      p_related_booking_ids => ARRAY[NEW.booking_id],
      p_payload             => jsonb_build_object('subject', 'New Review Received! &#11088;', 'html', v_html),
      p_public_summary      => jsonb_build_object('event_type', 'review_received_trainer', 'rating', NEW.rating)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_review_received: enqueue failed for review %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_booking_notification(
  p_booking_ids uuid[],
  p_kind        text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_occurred timestamptz;
  v_actor     uuid := auth.uid();
  v_ids       uuid[];
  v_n         int;
  v_scopes    int;
  v_trn_count int;
  v_recips    int;
  v_maxper    int;
  v_trainer   uuid;
  v_academy   uuid;
  v_owner     boolean;
  v_trn_user  uuid;
  v_trn_name  text;
  v_subject   text;
  v_html      text;
  v_rows      text;
  v_key       text;
  v_count     int := 0;
  v_guest_email text;
  v_price     numeric;
  v_title     text;
  v_contact   text;
  r           record;
  -- Bounds on caller-controlled work. Cancellation receives one booking ROW per session per
  -- player, so a 52-session cycle with several players is legitimately hundreds of rows — the
  -- old flat "60 bookings" cap mistook rows for sessions and rejected real cancellations.
  -- These are intent-aware: a hard total backstop, plus per-recipient and recipient-count
  -- caps, all comfortably above a real season (52) while keeping abuse bounded.
  MAX_TOTAL_ROWS            constant int := 2000;
  MAX_RECIPIENTS            constant int := 500;
  MAX_SESSIONS_PER_RECIPIENT constant int := 200;
  -- Guest-first canonical recipient key (FAM-02): a booking that carries a guest_player_id
  -- belongs to the GUEST regardless of any player_id, so it groups and addresses as the guest.
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'enqueue_booking_notification: no authenticated actor';
  END IF;

  IF coalesce(p_kind, '') NOT IN ('request_staff', 'confirmation_player', 'cancelled_player') THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown kind %', coalesce(p_kind, '<null>');
  END IF;

  -- CANONICAL SET: distinct + sorted, so argument order/duplicates cannot change the outcome.
  SELECT array_agg(DISTINCT b ORDER BY b) INTO v_ids
    FROM unnest(coalesce(p_booking_ids, ARRAY[]::uuid[])) AS b
   WHERE b IS NOT NULL;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  v_n := array_length(v_ids, 1);

  -- Absolute backstop on the caller-controlled array size.
  IF v_n > MAX_TOTAL_ROWS THEN
    RAISE EXCEPTION 'enqueue_booking_notification: too many bookings in one call (% > %)', v_n, MAX_TOTAL_ROWS;
  END IF;

  -- EVERY id must exist — never notify about the subset that happens to resolve.
  IF (SELECT count(*) FROM public.bookings WHERE id = ANY(v_ids)) <> v_n THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown booking id in set';
  END IF;

  -- TENANT = ACADEMY-FIRST. Cycle slots can move between trainers WITHIN one academy, so a
  -- multi-trainer set inside a single academy is ONE tenant (the academy) — an academy manager
  -- may act across its trainers. An INDEPENDENT set (no academy) must resolve to a single
  -- trainer. A set spanning academies, or academy + independent, has no coherent tenant.
  SELECT count(DISTINCT coalesce(s.academy_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)),
         (array_agg(DISTINCT s.academy_profile_id))[1],
         count(DISTINCT s.trainer_id),
         (array_agg(DISTINCT s.trainer_id))[1]
    INTO v_scopes, v_academy, v_trn_count, v_trainer
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
   WHERE b.id = ANY(v_ids);
  IF v_scopes <> 1 THEN
    RAISE EXCEPTION 'enqueue_booking_notification: booking set spans multiple academy scopes';
  END IF;
  IF v_academy IS NULL AND v_trn_count <> 1 THEN
    RAISE EXCEPTION 'enqueue_booking_notification: independent slots span multiple trainers';
  END IF;
  -- Effective tenant trainer: the single trainer if the set has exactly one, else NULL (a
  -- multi-trainer academy cycle) — so no single trainer is named falsely in the copy.
  IF v_trn_count <> 1 THEN v_trainer := NULL; END IF;

  -- request_staff addresses ONE trainer; there is no coherent approver across several.
  IF p_kind = 'request_staff' AND v_trainer IS NULL THEN
    RAISE EXCEPTION 'enqueue_booking_notification: request_staff needs a single trainer';
  END IF;

  -- INTENT-AWARE BOUNDS. request_staff/confirmation address one recipient (v_n sessions);
  -- cancellation fans out to many. Prove-a-52x2-cancellation-succeeds sizing.
  IF p_kind = 'request_staff' THEN
    IF v_n > MAX_SESSIONS_PER_RECIPIENT THEN
      RAISE EXCEPTION 'enqueue_booking_notification: too many sessions for one request (% > %)', v_n, MAX_SESSIONS_PER_RECIPIENT;
    END IF;
  ELSE
    SELECT count(*), coalesce(max(cnt), 0) INTO v_recips, v_maxper FROM (
      SELECT CASE WHEN b.guest_player_id IS NOT NULL THEN 'g:' || b.guest_player_id::text
                  ELSE 'p:' || coalesce(pr.user_id::text, 'none') END AS rkey,
             count(*) AS cnt
        FROM public.bookings b
        LEFT JOIN public.profiles pr ON pr.id = b.player_id
       WHERE b.id = ANY(v_ids)
       GROUP BY 1
    ) g;
    IF v_recips > MAX_RECIPIENTS THEN
      RAISE EXCEPTION 'enqueue_booking_notification: too many recipients (% > %)', v_recips, MAX_RECIPIENTS;
    END IF;
    IF v_maxper > MAX_SESSIONS_PER_RECIPIENT THEN
      RAISE EXCEPTION 'enqueue_booking_notification: too many sessions for one recipient (% > %)', v_maxper, MAX_SESSIONS_PER_RECIPIENT;
    END IF;
  END IF;

  -- Content the LEGACY templates carried, derived here rather than accepted from the caller.
  SELECT sum(coalesce(b.payment_amount, s.price_per_session, 0)),
         max(nullif(btrim(coalesce(s.cyclus_name, '')), ''))
    INTO v_price, v_title
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
   WHERE b.id = ANY(v_ids);

  -- The trainer name is NULL for a multi-trainer academy cycle (v_trainer NULL), so the copy
  -- below degrades to a generic "je trainer" rather than naming one arbitrary trainer.
  SELECT tp.user_id INTO v_trn_user FROM public.trainer_profiles tp WHERE tp.id = v_trainer;
  SELECT pr.full_name INTO v_trn_name FROM public.profiles pr WHERE pr.user_id = v_trn_user;

  -- Ownership. An individual trainer may act only when the set is theirs (single trainer, and
  -- the actor owns it); an academy manager may act across the academy's trainers. Three
  -- redundant fail-closed layers (IS NOT NULL guards + IS TRUE + IS NOT TRUE at the use site)
  -- keep a NULL comparison from sailing through as "not rejected".
  v_owner := (
    (v_trainer IS NOT NULL AND v_trn_user IS NOT NULL AND v_actor = v_trn_user)
    OR (v_academy IS NOT NULL AND public.is_academy_manager(v_actor, v_academy) IS TRUE)
  ) IS TRUE;

  -- ── AUTH MATRIX + STATE VALIDATION, over the WHOLE set ────────────────────────────────
  IF p_kind = 'request_staff' THEN
    -- PURE-PROFILE ownership (FAM-02): the `b.guest_player_id IS NULL` guard is load-bearing.
    -- A DUAL-KEY booking belongs to the GUEST person, not the profile, so a parent/profile
    -- account whose user_id matches must NOT be able to request staff mail for a guest's
    -- booking. Without the guard, `pr.user_id = v_actor` alone would grant it.
    IF EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((b.guest_player_id IS NULL AND pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is not the player on every booking';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = ANY(v_ids) AND status IS DISTINCT FROM 'pending_approval') THEN
      RAISE EXCEPTION 'enqueue_booking_notification: request_staff needs pending_approval bookings';
    END IF;

  ELSIF p_kind = 'confirmation_player' THEN
    -- Same PURE-PROFILE guard: a profile account cannot self-confirm a guest's dual-key
    -- booking. Either the slot owner (v_owner) or the player on every PURE-PROFILE booking.
    IF v_owner IS NOT TRUE AND EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((b.guest_player_id IS NULL AND pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is neither the player nor the slot owner';
    END IF;
    -- ONE recipient, by the GUEST-FIRST canonical key: a guest-only row and a dual-key row for
    -- the SAME guest are one recipient, not two (the old DISTINCT (player_id, guest_player_id)
    -- counted them separately and rejected the confirmation).
    IF (SELECT count(DISTINCT CASE WHEN b.guest_player_id IS NOT NULL THEN 'g:' || b.guest_player_id::text
                                   ELSE 'p:' || coalesce(pr.user_id::text, 'none') END)
          FROM public.bookings b
          LEFT JOIN public.profiles pr ON pr.id = b.player_id
         WHERE b.id = ANY(v_ids)) <> 1 THEN
      RAISE EXCEPTION 'enqueue_booking_notification: confirmation set covers multiple recipients';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.bookings
       WHERE id = ANY(v_ids)
         AND (status IS DISTINCT FROM 'confirmed' OR payment_status = 'paid')
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: confirmation needs unpaid CONFIRMED bookings';
    END IF;

  ELSE  -- cancelled_player
    IF v_owner IS NOT TRUE THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor does not own this slot';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = ANY(v_ids) AND status NOT IN ('cancelled', 'cancelled_swap')) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: cancelled_player needs cancelled bookings';
    END IF;
  END IF;

  v_key := p_kind || ':' || md5(array_to_string(v_ids, ','));

  IF p_kind = 'request_staff' THEN
    IF v_trn_user IS NULL THEN RETURN 0; END IF;   -- orphan trainer: nobody to notify
    SELECT string_agg(
             '<tr><td style="padding:4px 12px 4px 0">' || to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam', 'DD-MM-YYYY')
             || '</td><td style="padding:4px 12px 4px 0">' || to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
             || '–' || to_char(s.end_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
             || '</td><td style="padding:4px 0">' || public.notification_html_escape(l.name) || '</td></tr>',
             '' ORDER BY s.start_time)
      INTO v_rows
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      LEFT JOIN public.locations l ON l.id = s.location_id
     WHERE b.id = ANY(v_ids);

    SELECT public.notification_html_escape(coalesce(pr.full_name, gp.full_name, 'Een speler')),
           public.notification_html_escape(coalesce(pr.email, gp.email, ''))
      INTO v_subject, v_contact
      FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
     WHERE b.id = v_ids[1];

    v_html := '<div style="font-family:sans-serif"><h2>Nieuwe boekingsaanvraag</h2><p>Hoi '
      || public.notification_html_escape(v_trn_name) || ',</p><p>' || v_subject
      || ' heeft een aanvraag gedaan'
      || CASE WHEN v_title IS NOT NULL THEN ' voor <strong>' || public.notification_html_escape(v_title) || '</strong>' ELSE '' END
      || ':</p><table>' || coalesce(v_rows, '') || '</table>'
      || CASE WHEN v_contact <> '' THEN '<p>Contact: <a href="mailto:' || v_contact || '">' || v_contact || '</a></p>' ELSE '' END
      || CASE WHEN coalesce(v_price, 0) > 0 THEN '<p>Bedrag: &euro;' || to_char(v_price, 'FM999999990.00') || '</p>' ELSE '' END
      || '<p><a href="https://padeltrainer.ai/app/trainer/agenda">Bekijk en beoordeel de aanvraag</a></p></div>';

    SELECT min(b.created_at) INTO v_occurred FROM public.bookings b WHERE b.id = ANY (v_ids);
    IF v_occurred IS NULL THEN
      RAISE EXCEPTION 'enqueue_booking_notification: no booking in % — refusing to enqueue a message we cannot date', v_ids;
    END IF;
    SELECT count(*) INTO v_count FROM public.enqueue_notification(
      p_event_key                 => 'booking_request_staff',
      p_occurred_at               => v_occurred,
      p_recipient_user_id         => v_trn_user,
      p_tenant_trainer_id         => v_trainer,
      p_tenant_academy_profile_id => v_academy,
      p_idempotency_subject       => v_key,
      p_related_booking_ids       => v_ids,
      p_payload                   => jsonb_build_object('subject', 'Nieuwe boekingsaanvraag', 'html', v_html),
      p_public_summary            => jsonb_build_object('event_type', 'booking_request_staff', 'sessions', array_length(v_ids, 1))
    );

  ELSE
    -- confirmation_player and cancelled_player fan out PER RECIPIENT, each seeing ONLY their
    -- own sessions, grouped by the GUEST-FIRST canonical key. ruser/rguest are XOR by
    -- construction (uid is NULL for a guest row, gid NULL for a player row), so the resolver
    -- never receives both and can never prefer a registered profile over the intended guest.
    FOR r IN
      SELECT d.uid AS ruser, d.gid AS rguest, d.rname,
             array_agg(d.id ORDER BY d.id) AS ids,
             string_agg(
               '<tr><td style="padding:4px 12px 4px 0">' || to_char(d.start_time AT TIME ZONE 'Europe/Amsterdam', 'DD-MM-YYYY')
               || '</td><td style="padding:4px 12px 4px 0">' || to_char(d.start_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
               || '–' || to_char(d.end_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
               || '</td><td style="padding:4px 0">' || public.notification_html_escape(d.loc) || '</td></tr>',
               '' ORDER BY d.start_time) AS rows
        FROM (
          SELECT b.id, s.start_time, s.end_time, l.name AS loc,
                 b.guest_player_id AS gid,
                 CASE WHEN b.guest_player_id IS NULL THEN pr.user_id ELSE NULL END AS uid,
                 CASE WHEN b.guest_player_id IS NOT NULL THEN coalesce(gp.full_name, '')
                      ELSE coalesce(pr.full_name, '') END AS rname
            FROM public.bookings b
            JOIN public.availability_slots s ON s.id = b.slot_id
            LEFT JOIN public.locations l ON l.id = s.location_id
            LEFT JOIN public.profiles pr ON pr.id = b.player_id
            LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
           WHERE b.id = ANY(v_ids)
        ) d
       GROUP BY d.gid, d.uid, d.rname
    LOOP
      CONTINUE WHEN r.ruser IS NULL AND r.rguest IS NULL;   -- nobody to address

      -- A guest has no account for the resolver to fall back on, so make them deliverable
      -- FIRST. Recipient-discovery fails LOUD (PR 10a): an error would otherwise promote a
      -- stale raw address into the tenant contact. A successful no-row/no-email answer uses
      -- the designed guest-record fallback.
      IF r.rguest IS NOT NULL THEN
        SELECT i.email INTO v_guest_email
          FROM public.get_invoice_recipient_identity(NULL, r.rguest, v_academy) AS i;
        IF coalesce(btrim(v_guest_email), '') = '' THEN
          SELECT gp.email INTO v_guest_email FROM public.guest_players gp WHERE gp.id = r.rguest;
        END IF;
        PERFORM public.ensure_guest_email_contact(
          r.rguest, v_guest_email, v_academy, v_trainer, 'staff_booking');
      END IF;

      IF p_kind = 'confirmation_player' THEN
        v_subject := 'Je boeking is bevestigd';
        v_html := '<div style="font-family:sans-serif"><h2>Je boeking is bevestigd</h2><p>Hoi '
          || public.notification_html_escape(r.rname) || ',</p><p>Je sessie(s)'
          || CASE WHEN v_title IS NOT NULL THEN ' voor <strong>' || public.notification_html_escape(v_title) || '</strong>' ELSE '' END
          || ' staan klaar. Betaling regel je met '
          || public.notification_html_escape(coalesce(v_trn_name, 'je trainer'))
          || '.</p><table>' || coalesce(r.rows, '') || '</table>'
          || CASE WHEN coalesce(v_price, 0) > 0 THEN '<p>Bedrag: &euro;' || to_char(v_price, 'FM999999990.00') || '</p>' ELSE '' END
          || '</div>';
      ELSE
        v_subject := 'Je sessie is geannuleerd';
        v_html := '<div style="font-family:sans-serif"><h2>Je sessie is geannuleerd</h2><p>'
          || public.notification_html_escape(coalesce(v_trn_name, 'Je trainer'))
          || ' heeft de volgende sessie(s) geannuleerd:</p><table>' || coalesce(r.rows, '')
          || '</table><p>Neem contact op met je trainer voor een alternatief.</p></div>';
      END IF;

      SELECT min(b.created_at) INTO v_occurred FROM public.bookings b WHERE b.id = ANY (r.ids);
      IF v_occurred IS NULL THEN
        RAISE EXCEPTION 'enqueue_booking_notification: no booking in % — refusing to enqueue a message we cannot date', r.ids;
      END IF;
      SELECT v_count + count(*) INTO v_count FROM public.enqueue_notification(
        p_occurred_at               => v_occurred,
        p_event_key                 => CASE WHEN p_kind = 'confirmation_player'
                                            THEN 'booking_confirmed_player' ELSE 'booking_cancelled_player' END,
        p_recipient_user_id         => r.ruser,
        p_recipient_guest_player_id => r.rguest,
        p_tenant_trainer_id         => v_trainer,
        p_tenant_academy_profile_id => v_academy,
        p_idempotency_subject       => v_key || ':' || md5(array_to_string(r.ids, ',')),
        p_related_booking_ids       => r.ids,
        p_payload                   => jsonb_build_object('subject', v_subject, 'html', v_html),
        p_public_summary            => jsonb_build_object(
                                         'event_type', CASE WHEN p_kind = 'confirmation_player'
                                           THEN 'booking_confirmed_player' ELSE 'booking_cancelled_player' END,
                                         'sessions', array_length(r.ids, 1))
      );
    END LOOP;
  END IF;

  RETURN v_count;
END;
$$;

-- ── 8. the operator can SEE what the occurrence floor is holding ────────────────────────────
-- A guard that silently stops sending is indistinguishable from a broken worker. Both admin reads
-- gain the other clock, so the answer to "why has this not gone out?" is on the screen rather than
-- in a query someone has to invent during an incident.

CREATE OR REPLACE FUNCTION public.admin_notification_readiness() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  checks jsonb := '[]'::jsonb;
  v bigint; v2 bigint;
  v_cron text;
  v_txt text;
  add_fail boolean := false;
BEGIN
  PERFORM public.notif_admin_gate();

  -- kill switches: authoritative DB state (M4 pin)
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_channel_kill_switches LIMIT 11) b;
  checks := checks || jsonb_build_object('id', 'channel_kills', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' channel(s) killed');
  add_fail := add_fail OR v > 0;

  -- circuit state
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_provider_circuit WHERE state <> 'closed' LIMIT 11) b;
  checks := checks || jsonb_build_object('id', 'provider_circuits', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' circuit(s) not closed');
  add_fail := add_fail OR v > 0;

  -- unresolved deliberate invocations (M1)
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_worker_invocations WHERE status IN ('pending', 'started') LIMIT 11) b;
  checks := checks || jsonb_build_object('id', 'unresolved_invocations', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' deliberate invocation(s) unresolved');
  add_fail := add_fail OR v > 0;

  -- in-flight work: claimed/sending/uncertain
  -- the verdict needs zero/nonzero authority, not an exact tally: every scan is LIMIT-bounded,
  -- and a SATURATED count says 'at least' — a bounded count presented as exact misleads
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_outbox WHERE status = 'processing' LIMIT 1001) b;
  SELECT count(*) INTO v2 FROM (SELECT 1 FROM public.notification_digest_groups
   WHERE state IN ('sending', 'awaiting_evidence') OR (uncertain_since IS NOT NULL AND terminal_at IS NULL) LIMIT 1001) b;
  checks := checks || jsonb_build_object('id', 'in_flight_work', 'status', CASE WHEN v + v2 = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000) + least(v2, 1000), 'capped', (v > 1000 OR v2 > 1000),
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END || ' instant row(s) processing, '
           || CASE WHEN v2 > 1000 THEN 'at least 1000' ELSE v2::text END || ' digest group(s) mid-send/uncertain');
  add_fail := add_fail OR (v + v2) > 0;

  -- quarantined orphans await a human
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_orphan_reconcile_state WHERE quarantined LIMIT 1001) b;
  checks := checks || jsonb_build_object('id', 'quarantined_orphans', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000), 'capped', v > 1000,
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END || ' orphan(s) quarantined');
  add_fail := add_fail OR v > 0;

  -- cron IDENTITY, not merely active (finding 9): plain allowlisted SELECT, no command text
  BEGIN
    SELECT CASE WHEN j.active THEN 'active' ELSE 'inactive' END INTO v_cron
      FROM cron.job j WHERE j.jobname = 'notification-digest-worker' LIMIT 1;
    v_txt := coalesce(v_cron, 'absent');
  EXCEPTION WHEN OTHERS THEN
    v_txt := 'unavailable';
  END;
  checks := checks || jsonb_build_object('id', 'digest_cron', 'status',
    CASE v_txt WHEN 'inactive' THEN 'pass' WHEN 'unavailable' THEN 'not_provable' ELSE 'fail' END,
    'detail', 'notification-digest-worker: ' || v_txt || ' (identity/hash verification lives in the reviewed rollout artifacts, not here)');
  add_fail := add_fail OR v_txt IN ('active', 'absent');

  -- THE ENV SWITCH — the visible line, never a tooltip, never implied verified (finding 16)
  checks := checks || jsonb_build_object('id', 'digest_send_enabled_env', 'status', 'not_provable',
    'detail', 'DIGEST_SEND_ENABLED is an edge env var no SQL can read — operator assertion only');

  -- ── N5: the two checks that were reported not_provable until the machinery existed ────────
  -- (1) THE MECHANISM. Every delivery path must carry a durable, coherent boundary row — that is
  -- what makes "no historical work" enforceable rather than asserted. A missing or incoherent row
  -- is a FAIL: its send authority would be gating on nothing.
  SELECT count(*) INTO v FROM public.notification_activation_boundaries;
  SELECT count(*) INTO v2 FROM public.notification_activation_boundaries
   WHERE (state = 'active' AND boundary_at IS NULL) OR (state = 'inert' AND boundary_at IS NOT NULL);
  checks := checks || jsonb_build_object('id', 'durable_activation_boundary',
    'status', CASE WHEN v = 3 AND v2 = 0 THEN 'pass' ELSE 'fail' END,
    'value', v,
    'detail', (SELECT string_agg(b.path || '=' || b.state
                 || coalesce(' since ' || to_char(b.boundary_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), ''), ', ' ORDER BY b.path)
                 FROM public.notification_activation_boundaries b)
              || CASE WHEN v <> 3 THEN ' — expected 3 delivery paths, found ' || v ELSE '' END
              || CASE WHEN v2 > 0 THEN ' — ' || v2 || ' incoherent row(s)' ELSE '' END);
  add_fail := add_fail OR v <> 3 OR v2 > 0;

  -- (2) THE BACKLOG ITSELF. The send authorities already REFUSE pre-boundary rows (that is the
  -- invariant, and it is mutation-tested), so this counts what that refusal is holding back:
  -- pending rows that predate their own path's boundary and can therefore never send. Zero is
  -- the ready state; anything else is work an operator must dispose of deliberately, never work
  -- that quietly waits for a switch. Saturating, like every other count here.
  SELECT count(*) INTO v FROM (
    SELECT 1
      FROM public.notification_outbox o
      JOIN public.notification_activation_boundaries b
        ON b.path = o.channel || CASE WHEN o.delivery_mode = 'digest' THEN ':digest' ELSE ':instant' END
     WHERE o.status = 'pending' AND b.state = 'active' AND o.created_at < b.boundary_at
     LIMIT 1001) x;
  -- …and the same fact ONE HOP LATER (round 2): a group holding a pre-boundary member can never
  -- send either, because a digest is delivered whole. Counted separately so the detail says which
  -- shape the operator is looking at — the disposal clears rows, a group needs the state machine.
  SELECT count(*) INTO v2 FROM (
    SELECT 1
      FROM public.notification_digest_groups g
      JOIN public.notification_activation_boundaries b
        ON b.path = g.channel || ':digest' AND b.state = 'active'
     WHERE g.terminal_at IS NULL
       AND EXISTS (SELECT 1 FROM public.notification_outbox o
                    WHERE o.digest_group_id = g.id AND o.created_at < b.boundary_at)
     LIMIT 1001) y;
  checks := checks || jsonb_build_object('id', 'pre_activation_backlog_eligible_count',
    'status', CASE WHEN v + v2 = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000) + least(v2, 1000), 'capped', (v > 1000 OR v2 > 1000),
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END
              || ' pending row(s) and '
              || CASE WHEN v2 > 1000 THEN 'at least 1000' ELSE v2::text END
              || ' non-terminal group(s) predate their path''s activation boundary — refused by every send authority; rows are disposable through admin_dispose_pre_boundary_backlog');
  add_fail := add_fail OR (v + v2) > 0;

  -- …and the same question asked of the OCCURRENCE clock. A row can be perfectly post-boundary
  -- and still report an event older than the path's ceiling — that is the replay case, and it is
  -- refused by exactly the same authorities. It is counted separately because it leaves by a
  -- different door.
  SELECT count(*) INTO v FROM (
    SELECT 1
      FROM public.notification_outbox o
      JOIN public.notification_activation_boundaries b
        ON b.path = o.channel || CASE WHEN o.delivery_mode = 'digest' THEN ':digest' ELSE ':instant' END
     WHERE o.status = 'pending' AND b.state = 'active'
       AND o.created_at >= b.boundary_at
       AND o.occurred_at < public.notif_activation_min_occurred_at(b.path)
     LIMIT 1001) x;
  checks := checks || jsonb_build_object('id', 'pre_occurrence_floor_backlog_count',
    'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000), 'capped', v > 1000,
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END
              || ' pending row(s) report an event older than their path''s occurrence floor — refused by the send authorities, and disposable through admin_dispose_stale_outbox');
  add_fail := add_fail OR v > 0;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'as_of', now(),
    -- 'fail' when anything failed; otherwise 'not_provable' — NEVER 'pass', because
    -- DIGEST_SEND_ENABLED is an edge env var no SQL can read. N5 made the two boundary checks
    -- real, which moves them out of this sentence: what keeps the overall verdict at
    -- not_provable is now ONLY the env switch (and the cron read, where it is unavailable).
    'readiness', CASE WHEN add_fail THEN 'fail' ELSE 'not_provable' END,
    'checks', checks
  );
END;
$$;

-- the per-path read the admin page renders: the ceiling, the floor it implies right now, and how
-- much is stuck behind each clock.
DROP FUNCTION IF EXISTS public.admin_notification_activation_boundaries();
CREATE OR REPLACE FUNCTION public.admin_notification_activation_boundaries() RETURNS TABLE (
  path text, state text, boundary_at timestamptz, reason text, activated_by uuid,
  pending_before_boundary int, pending_before_boundary_capped boolean,
  max_event_age_minutes int, min_occurred_at timestamptz,
  pending_before_occurrence_floor int, pending_before_occurrence_floor_capped boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE CAP constant int := 1000;
BEGIN
  PERFORM public.notif_admin_gate();
  RETURN QUERY
  SELECT b.path, b.state, b.boundary_at, b.reason, b.activated_by,
         least(x.n, CAP)::int, x.n > CAP,
         b.max_event_age_minutes,
         public.notif_activation_min_occurred_at(b.path),
         least(o.n, CAP)::int, o.n > CAP
    FROM public.notification_activation_boundaries b
    CROSS JOIN LATERAL (
      SELECT count(*)::bigint AS n FROM (
        SELECT 1 FROM public.notification_outbox o
         WHERE b.state = 'active'
           AND o.status = 'pending'
           AND o.channel = split_part(b.path, ':', 1)
           AND (CASE WHEN split_part(b.path, ':', 2) = 'digest'
                     THEN o.delivery_mode = 'digest' AND o.digest_group_id IS NULL
                     ELSE o.delivery_mode IS DISTINCT FROM 'digest' END)
           AND o.created_at < b.boundary_at
         LIMIT CAP + 1) y) x
    CROSS JOIN LATERAL (
      -- post-boundary but over-age: the replay shape, counted where the boundary count cannot see it
      SELECT count(*)::bigint AS n FROM (
        SELECT 1 FROM public.notification_outbox o
         WHERE b.state = 'active'
           AND o.status = 'pending'
           AND o.channel = split_part(b.path, ':', 1)
           AND (CASE WHEN split_part(b.path, ':', 2) = 'digest'
                     THEN o.delivery_mode = 'digest' AND o.digest_group_id IS NULL
                     ELSE o.delivery_mode IS DISTINCT FROM 'digest' END)
           AND o.created_at >= b.boundary_at
           AND o.occurred_at < public.notif_activation_min_occurred_at(b.path)
         LIMIT CAP + 1) y) o
   ORDER BY b.path;
END;
$$;
COMMENT ON FUNCTION public.admin_notification_activation_boundaries() IS
  'N5 + audit: one row per delivery path — its state, its boundary, who opened it and why, its event-age ceiling and the occurrence floor that implies right now, and how many pending rows each clock is refusing (both saturating at 1000). The admin surface reads this; opening a path is a runbook act and is not exposed here.';
REVOKE ALL ON FUNCTION public.admin_notification_activation_boundaries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_activation_boundaries() TO authenticated, service_role;
