-- D7 RUNTIME — ONE CLOSED PROTECTED-EVENT VOCABULARY, AND THE CLAIMERS THAT MUST HONOUR IT.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_CANONICAL_OUTBOX_TRANSPORT_IMPLEMENTATION_V1`):
--   `ARCHITECTURE=ONE_CANONICAL_NOTIFICATION_OUTBOX_AUTHORITY_NO_NEW_PARALLEL_ATTEMPT_RELATION`
--   `VOCABULARY=ONE_CLOSED_rebook_round_protected_event_types_FUNCTION_NEVER_A_PATTERN_MATCH`
--   `APPLY_ORDER_HARDENING=CREATE_THE_NEW_PROTECTED_EVENT_TYPE_AND_WIDEN_EVERY_DISCOVERED_GENERIC
--    _EMAIL_AND_WHATSAPP_CLAIMER_EXCLUSION_IN_THE_SAME_EARLIEST_SUCCESSOR_MIGRATION`
--
-- ── WHY THE VOCABULARY AND THE EXCLUSIONS ARE ONE FILE ──────────────────────────────────────
--
-- The preflight proposed them as two migrations and the owner corrected it, rightly. Split across
-- two transactions there is a window in which `rebook_priority_claim_invite` EXISTS as an event
-- type while `claim_notification_outbox_batch` does not yet exclude it — and in that window the
-- shipped generic email worker would claim such a row, send it, and on a crash RE-CLAIM it:
--
--     OR (o.status = 'processing'
--         AND o.locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1)))
--
-- which is an automatic re-send of a row whose provider outcome is unknown — the exact defect this
-- whole batch exists to remove. Relying on "the sender is deployed later" would make correctness a
-- property of deploy order. It is now a property of the transaction.
--
-- ── WHAT IS PROTECTED, AND WHY IT IS A SET AND NOT A PATTERN ────────────────────────────────
--
-- A closed ARRAY, in the idiom ABC-27 already uses for `rebook_round_transport_states()`. An event
-- type is protected because it is NAMED here — never because it matches a prefix. A LIKE
-- 'rebook_%' would silently protect (and therefore silently un-claimable-ise) every future rebook
-- event somebody adds, which is the opposite of a reviewed decision.
--
-- ── WHERE THE INVITE'S CLAIM IS ANCHORED — CORRECTED ────────────────────────────────────────
--
-- This file originally argued that an invite needs NO claim column, because the deterministic key
-- `priority-claim-invite:<claim>` plus the outbox's unique idempotency already give exactly one row
-- per claim. Two things in that argument are wrong and are corrected here rather than left standing:
--
--   The key is not the SUBJECT. `20261203260000` adds `related_slot_priority_claim_id` because the
--     transport transition and operation-target rows must name a canonical immutable UUID, and the
--     outbox guard must resolve the claim to check that the row's recipient identity is the claim's
--     own. A parsed substring of an idempotency key is not an authority; a column is.
--
--   The unique is TENANT-SCOPED. `20261015100000` replaced `(channel, idempotency_key)` with
--     `(channel, idempotency_key, tenant_scope_key)`, where `tenant_scope_key` is GENERATED from the
--     tenant columns. Any ON CONFLICT for a protected row must name all three, and code written
--     against the two-column form would not have compiled against the shipped constraint.
--
-- What survives from the original argument is the part that matters: one row per claim per channel
-- per tenant, permanently — a durable idempotency with no time bound, which is the property Resend's
-- 24-hour window could not provide.

DO $d7_protected_events$
DECLARE
  v_n    name;
  v_src  text;
  v_new  text;
  v_ident text;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regclass('public.notification_event_types') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27)';
    RETURN;
  END IF;

  SELECT c.relowner::regrole::name INTO v_n
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.notification_outbox');
  IF v_n IS NULL THEN
    RAISE EXCEPTION 'D7 protected events: cannot resolve the Domain-N owner';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_n, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 protected events: % is not a member of the Domain-N owner %', current_user, v_n;
  END IF;

  -- ── (1) THE VOCABULARY ────────────────────────────────────────────────────────────────────
  CREATE OR REPLACE FUNCTION public.rebook_round_protected_event_types()
  RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $pe$
    -- THE CLOSED SET OF EVENT TYPES WHOSE TRANSPORT IS OWNED BY THE D7 MACHINE.
    --
    -- Membership means three things at once, and they stand or fall together: the generic claimers
    -- must not touch these rows; their stale-lease recovery is the D7 janitor's, which resolves a
    -- lost dispatch to `acceptance_uncertain` rather than back to a sendable state; and a row that
    -- ever reached dispatch is retained rather than deleted.
    SELECT ARRAY['rebook_member_open_player', 'rebook_priority_claim_invite'];
  $pe$;
  EXECUTE format('ALTER FUNCTION public.rebook_round_protected_event_types() OWNER TO %I', v_n);
  REVOKE ALL ON FUNCTION public.rebook_round_protected_event_types()
    FROM PUBLIC, anon, authenticated, service_role;

  -- ── (2) THE EVENT TYPE ────────────────────────────────────────────────────────────────────
  --
  -- Shaped on the member-open row it sits beside: a `rebook` family, `actionable` priority (the
  -- recipient can act and the window expires), and NOT marketing — so no marketing suppression
  -- arm ever applies to a court somebody is holding.
  -- COLUMN-FOR-COLUMN ON THE MEMBER-OPEN ROW BESIDE IT, and the three that differ are the whole
  -- difference between the two events:
  --   requires_rebook_round_recipient  FALSE — an invite's subject is a priority CLAIM, not a
  --                                    round recipient. The member-open shape CHECK is written
  --                                    `event_type <> 'rebook_member_open_player' OR (...)`, so a
  --                                    new type passes it untouched; this says why that is right.
  --   trusted_payload_builder          NULL, and this is the correction that matters most here.
  --                                    A first draft named a builder and widened
  --                                    `chk_net_trusted_payload_builder` to admit it, reasoning that
  --                                    NULL would mean "no trusted builder". That had the column
  --                                    BACKWARDS. Setting it means THE SERVER BUILDS THE PAYLOAD AND
  --                                    A CALLER MAY NOT — `enqueue_notification` refuses outright
  --                                    with "builds its own payload; a caller payload is not
  --                                    accepted". Member-open needs that, because its content must
  --                                    not come from whoever calls. An invite's body is rendered by
  --                                    the SENDER, which owns the template, the claim-token URL and
  --                                    the branding; NULL is how every other caller-rendered event
  --                                    works, and it means the frozen-request widening of that CHECK
  --                                    is not needed at all. One fewer change to a frozen-file
  --                                    constraint.
  --   template_email                   the invite's own template.
  --
  -- NO `ON CONFLICT`. ABC-27 records the reason for its own bare INSERT and it holds here: every
  -- predicate downstream reads this row, so silently adopting an unknown one would switch those
  -- checks off invisibly. The guard below proves absence first, so a conflict is a violated
  -- assumption and must abort.
  IF EXISTS (SELECT 1 FROM public.notification_event_types
              WHERE key = 'rebook_priority_claim_invite') THEN
    RAISE EXCEPTION 'D7 protected events: rebook_priority_claim_invite already exists — this migration will not adopt a row it did not write';
  END IF;
  INSERT INTO public.notification_event_types
    (key, category, audience, priority, required_delivery,
     supports_email, supports_whatsapp, supports_push, supports_digest,
     default_email_frequency, default_whatsapp_frequency, default_push_frequency,
     collapse_window_minutes, quiet_hours_respect, visibility_scope,
     template_email, email_footer_policy, digest_engine_enabled, record_terminal_outcomes,
     requires_rebook_round, requires_rebook_round_recipient, trusted_payload_builder)
  VALUES
    ('rebook_priority_claim_invite', 'rebook', 'player', 'actionable', false,
     true, false, false, false,
     'instant', 'off', 'off',
     0, true, 'private_user_only',
     'rebook_priority_claim_invite', 'manage_prefs', false, true, true,
     false, NULL);

  -- ── (3) EVERY GENERIC CLAIM PATH, WIDENED TO THE SET ──────────────────────────────────────
  --
  -- Re-issued from the CATALOG, not transcribed: `pg_get_functiondef` then one exact substitution
  -- per site, each asserted to occur the expected number of times. Everything not substituted is
  -- byte-identical by construction — the discipline `20261203200000` applies to the frozen cores,
  -- for the same reason.
  FOREACH v_ident IN ARRAY ARRAY[
    'public.claim_notification_outbox_batch(text,text,int,int)',
    'public.release_notification_claims_on_kill(text,text)'
  ] LOOP
    IF to_regprocedure(v_ident) IS NULL THEN
      RAISE EXCEPTION 'D7 protected events: % is not installed', v_ident;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;

    IF v_ident LIKE 'public.claim_notification_outbox_batch%' THEN
      -- THREE sites, all of them exclusions ABC-27 already wrote for the member-open type. Each
      -- keeps its original reason as a comment; only the predicate widens.
      IF (length(v_src) - length(replace(v_src, 'event_type <> ''rebook_member_open_player''', '')))
         / length('event_type <> ''rebook_member_open_player''') <> 3 THEN
        RAISE EXCEPTION 'D7 protected events: expected exactly three member-open exclusions in the claimer, found a different shape';
      END IF;
      v_new := replace(v_src,
        'event_type <> ''rebook_member_open_player''',
        'event_type <> ALL (public.rebook_round_protected_event_types())');
    ELSE
      -- THE KILL RELEASE IS NOT A CLAIMER, AND IT IS STILL A WAY BACK TO SENDABLE.
      --
      -- It sets `status = 'pending'` for every `processing` row on a channel. For a protected row
      -- that is wrong twice over: D7 expresses a channel kill in its OWN vocabulary
      -- (`channel_kill_deferred`), and a row that was mid-dispatch when the kill fired is exactly
      -- the row whose provider outcome is unknown. Returning it to `pending` is the automatic
      -- re-send this batch exists to prevent, arriving through a door nobody would think to call a
      -- claimer.
      IF position('SET status = ''pending''' IN v_src) = 0 THEN
        RAISE EXCEPTION 'D7 protected events: the kill release no longer has the shape this migration reviewed';
      END IF;
      v_new := replace(v_src,
        'WHERE o.channel = p_channel',
        'WHERE o.channel = p_channel'
        || E'\n    AND o.event_type <> ALL (public.rebook_round_protected_event_types())');
      IF v_new = v_src THEN
        RAISE EXCEPTION 'D7 protected events: the kill release anchor did not match';
      END IF;
    END IF;

    IF v_new = v_src THEN
      RAISE EXCEPTION 'D7 protected events: % was not changed', v_ident;
    END IF;
    EXECUTE v_new;
    IF position('rebook_round_protected_event_types' IN
                pg_catalog.pg_get_functiondef(to_regprocedure(v_ident))) = 0 THEN
      RAISE EXCEPTION 'D7 protected events: % did not take the widened predicate', v_ident;
    END IF;
  END LOOP;

  -- ── (4) THE NEW TYPE IS AS UNDELETABLE AS THE ONE IT JOINS ────────────────────────────────
  --
  -- `guard_notification_event_type_authority` makes the member-open key security-bearing: it may
  -- not be deleted, and its authority-carrying columns may not be edited. A protected event type
  -- whose row could be deleted or re-classified would let somebody turn the transport protection
  -- off without touching any of the machinery that enforces it.
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.guard_notification_event_type_authority()'))
    INTO v_src;
  IF (length(v_src) - length(replace(v_src, '''rebook_member_open_player''', '')))
     / length('''rebook_member_open_player''') <> 2 THEN
    RAISE EXCEPTION 'D7 protected events: the event-type guard no longer has the two-site shape this migration reviewed';
  END IF;
  v_new := replace(v_src, 'OLD.key = ''rebook_member_open_player''',
                          'OLD.key = ANY (public.rebook_round_protected_event_types())');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'D7 protected events: the event-type guard did not take the widened predicate';
  END IF;
  EXECUTE v_new;

  RAISE NOTICE 'D7: the protected-event vocabulary is installed and every generic claim path honours it';
END $d7_protected_events$;
