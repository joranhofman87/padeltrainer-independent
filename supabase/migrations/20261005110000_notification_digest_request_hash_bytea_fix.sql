-- PR 10c-a3 (worker prerequisite) — CORRECTNESS FIX for a latent bug in the deployed (inert) state machine
-- 20261004100000: every request/canonical-key hash used `expr::text::bytea`, which runs the bytea INPUT
-- function and INTERPRETS backslash escapes. A jsonb::text of any real frozen request contains `\"` (HTML has
-- quoted attributes), so `sha256(frozen_request::text::bytea)` raises `invalid input syntax for type bytea` and
-- store/guard would reject EVERY genuine email. The 10c-a2 suite only ever stored `<p>x</p>` (no quotes), so it
-- never surfaced. Fix, as a CLASS, every hash site: `convert_to(expr::text,'UTF8')` takes the text's raw UTF-8
-- bytes with NO escape interpretation. For all backslash-free text (every valid email + canonical key) the two
-- produce byte-identical input to sha256, so every existing hash VALUE is preserved — this only stops the throw
-- on quoted/backslashed content. Forward-only CREATE OR REPLACE (deployed migrations are never edited in place);
-- privileges/triggers persist across REPLACE. Still INERT: no worker scheduled, no digest event enabled.


-- digest_group_hash stamp trigger (canonical-key hash on every digest outbox row)
CREATE OR REPLACE FUNCTION public.notification_outbox_digest_hash_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.delivery_mode = 'digest'
     AND (TG_OP = 'INSERT' OR OLD.delivery_mode IS DISTINCT FROM 'digest' OR NEW.digest_group_hash IS NULL) THEN
    -- a digest row must carry a COMPLETE snapshot — grouping on partial identity would collapse rows wrongly.
    IF NEW.recipient_key IS NULL OR NEW.destination_fingerprint IS NULL
       OR NEW.digest_frequency IS NULL OR NEW.digest_boundary_at IS NULL OR NEW.digest_item IS NULL THEN
      RAISE EXCEPTION 'digest outbox row % is missing snapshot fields (recipient_key/destination_fingerprint/digest_frequency/digest_boundary_at/digest_item)', NEW.id;
    END IF;
    -- ALWAYS server-derived (on INSERT and on promotion to digest): a caller-supplied hash is overwritten,
    -- never trusted; the timezone is NORMALIZED so NULL and an explicit default mint the same identity.
    NEW.digest_group_hash := encode(sha256(convert_to(notif_digest_canonical_key(
      NEW.channel, NEW.recipient_key, NEW.destination_fingerprint, NEW.tenant_academy_profile_id,
      NEW.tenant_trainer_id, NEW.event_type, NEW.template_key, NEW.template_version,
      NEW.group_locale, NEW.digest_frequency, coalesce(NEW.recipient_timezone, 'Europe/Amsterdam'),
      NEW.digest_boundary_at)::text, 'UTF8')), 'hex');
  END IF;
  -- server-derive the byte count from the STORED item on every digest write (never trust a caller count);
  -- this fires before the snapshot guard, so a forged count on an unchanged item is silently corrected and a
  -- scrubbed (NULL) item leaves the last derived count for audit + the 50-item/90 KB budget.
  IF NEW.delivery_mode = 'digest' AND NEW.digest_item IS NOT NULL THEN
    NEW.digest_item_bytes := octet_length(NEW.digest_item::text);
  END IF;
  RETURN NEW;
END $$;

-- materialize (its canonical-key fallback hash)
CREATE OR REPLACE FUNCTION public.materialize_notification_digest_groups(
    p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int, p_max_members_per_call int)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget int := 92160;                 -- ~90 KB cumulative byte budget per group
  v_groups int := 0; v_members int := 0; v_iter int := 0; v_lock_skips int := 0;
  cand record; m record;
  v_ckey jsonb; v_hash text; v_group uuid; v_count int; v_bytes int; v_next_chunk int; v_n int;
BEGIN
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

-- store (the frozen-request hash — the site that actually throws on real HTML)
CREATE OR REPLACE FUNCTION public.store_notification_digest_request(
    p_run_id uuid, p_group_id uuid, p_worker text, p_frozen_request jsonb, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_n int;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state = 'prepared' AND locked_by = p_worker AND worker_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: group % not owned/prepared by %', p_group_id, p_worker; END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);

  -- ONE shared validator (also enforced on the trigger's prepared→request_ready transition).
  PERFORM notif_digest_validate_frozen_request(p_frozen_request, g.destination_fingerprint);

  UPDATE public.notification_digest_groups
     SET frozen_request = p_frozen_request,
         request_hash = encode(sha256(convert_to(p_frozen_request::text, 'UTF8')), 'hex'),   -- server-side, never trusted
         provider_idempotency_key = 'dg:v1:' || p_group_id::text,
         state = 'request_ready', available_at = p_now, updated_at = p_now
   WHERE id = p_group_id AND state = 'prepared' AND locked_by = p_worker AND worker_run_id = p_run_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'store: group % concurrent change', p_group_id; END IF;
  PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'request_ready', 0);
END $$;

-- send-identity guard (re-validates request_hash on prepared→request_ready / send transitions)
CREATE OR REPLACE FUNCTION public.notification_digest_send_identity_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- provider_idempotency_key / request_hash: settable ONLY during the documented prepared→request_ready
  -- store transition; immutable thereafter. Constraining INITIALIZATION (not just mutation) blocks a forged
  -- one-statement populate on a pending/leased group.
  IF NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key THEN
    IF OLD.provider_idempotency_key IS NOT NULL THEN
      RAISE EXCEPTION 'notification_digest_groups.provider_idempotency_key is immutable once set';
    END IF;
    IF NOT (OLD.state = 'prepared' AND NEW.state = 'request_ready') THEN
      RAISE EXCEPTION 'provider_idempotency_key may only be set during prepared→request_ready';
    END IF;
    -- the key is schema-owned: it is always dg:v1:<group id>, never a caller value.
    IF NEW.provider_idempotency_key <> 'dg:v1:' || NEW.id::text THEN
      RAISE EXCEPTION 'provider_idempotency_key must equal dg:v1:<group id>';
    END IF;
  END IF;
  IF NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    IF OLD.request_hash IS NOT NULL THEN
      RAISE EXCEPTION 'notification_digest_groups.request_hash is immutable once set';
    END IF;
    IF NOT (OLD.state = 'prepared' AND NEW.state = 'request_ready') THEN
      RAISE EXCEPTION 'request_hash may only be set during prepared→request_ready';
    END IF;
    -- the hash is server-derived from the frozen request; a mismatch means a caller forged it.
    IF NEW.frozen_request IS NULL OR NEW.request_hash <> encode(sha256(convert_to(NEW.frozen_request::text, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'request_hash must equal sha256(frozen_request)';
    END IF;
  END IF;
  -- frozen_request: NULL→value ONLY at store (prepared→request_ready); value→NULL ONLY at a terminal scrub;
  -- never rewritten to a different body.
  IF NEW.frozen_request IS DISTINCT FROM OLD.frozen_request THEN
    IF OLD.frozen_request IS NULL THEN
      IF NOT (OLD.state = 'prepared' AND NEW.state = 'request_ready') THEN
        RAISE EXCEPTION 'frozen_request may only be set during prepared→request_ready';
      END IF;
    ELSIF NEW.frozen_request IS NULL THEN
      IF NOT (NEW.state = ANY(notif_digest_terminal_states())) THEN
        RAISE EXCEPTION 'frozen_request may only be scrubbed during a terminal transition';
      END IF;
    ELSE
      RAISE EXCEPTION 'notification_digest_groups.frozen_request may not be rewritten';
    END IF;
  END IF;
  -- first_send_at: settable ONLY during request_ready→sending with a bound current attempt; then immutable
  -- (the idempotency-key dedup window is anchored here — moving it could replay outside the provider window).
  IF NEW.first_send_at IS DISTINCT FROM OLD.first_send_at THEN
    IF OLD.first_send_at IS NOT NULL THEN
      RAISE EXCEPTION 'notification_digest_groups.first_send_at is immutable once set';
    END IF;
    IF NOT (OLD.state = 'request_ready' AND NEW.state = 'sending' AND NEW.current_attempt_id IS NOT NULL) THEN
      RAISE EXCEPTION 'first_send_at may only be set during request_ready→sending with a bound attempt';
    END IF;
  END IF;
  -- uncertain_deadline_at: never beyond first_send_at + 23h, and never moves later once set.
  IF NEW.uncertain_deadline_at IS NOT NULL THEN
    IF NEW.first_send_at IS NULL THEN
      RAISE EXCEPTION 'notification_digest_groups.uncertain_deadline_at requires first_send_at';
    END IF;
    IF NEW.uncertain_deadline_at > NEW.first_send_at + interval '23 hours' THEN
      RAISE EXCEPTION 'notification_digest_groups.uncertain_deadline_at exceeds first_send_at + 23h';
    END IF;
    IF OLD.uncertain_deadline_at IS NOT NULL AND NEW.uncertain_deadline_at > OLD.uncertain_deadline_at THEN
      RAISE EXCEPTION 'notification_digest_groups.uncertain_deadline_at may not move later';
    END IF;
  END IF;
  -- request-tuple COMPLETENESS: the prepared→request_ready transition must ATOMICALLY carry the whole frozen
  -- request tuple (checked on the transition itself, not field-by-field) — a state-only move that leaves the
  -- request null would strand a malformed group that can never call store.
  IF OLD.state = 'prepared' AND NEW.state = 'request_ready' THEN
    IF NEW.frozen_request IS NULL
       OR NEW.provider_idempotency_key IS DISTINCT FROM 'dg:v1:' || NEW.id::text
       OR NEW.request_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.frozen_request::text, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'prepared→request_ready must atomically establish the complete frozen request tuple (frozen_request + dg:v1 key + sha256 hash)';
    END IF;
    -- and the request CONTENT must pass the same validator the store RPC uses (allow-list + fingerprint) —
    -- a complete-but-unsafe tuple (right hash/key, wrong recipient / extra bcc) is rejected here too.
    PERFORM notif_digest_validate_frozen_request(NEW.frozen_request, NEW.destination_fingerprint);
  END IF;
  RETURN NEW;
END $$;

-- destination fingerprint (defends a backslash in a destination; value-preserving)
CREATE OR REPLACE FUNCTION public.notif_digest_destination_fingerprint(p_destination text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(lower(btrim(p_destination)), 'UTF8')), 'hex') $$;
