-- D7 RUNTIME — THE ENQUEUE, BOUND TO THE OFFER IT WAS RENDERED FROM.
--
-- OWNER DECISIONS: `RENDERED_BINDING=MANDATORY_ECHOED_FACTS_VERIFIED_FIELD_BY_FIELD_OMISSION_IS_
-- REFUSAL`, `LOCK=CANONICAL_ADVISORY_LOCK_IS_THE_FIRST_STATEMENT_BEFORE_ANY_AUTHORITATIVE_READ`,
-- `COHERENCE=CAPTURE_SOURCE_SLOT_MUST_EQUAL_THE_CLAIM_SLOT_AT_ENQUEUE`,
-- `RE_INVITATION=A_KEY_INCLUDES_OFFER_DIGEST` with its reuse and safety rules.
--
-- ── THE BINDING IS MANDATORY, AND THE SERVER STILL DECIDES ─────────────────────────────────
--
-- The previous version checked the rendered slot only WHEN THE CALLER SUPPLIED IT — so omitting the
-- field skipped the check, and the test helper omitted it everywhere but one test. That conditional
-- existed so the existing tests would keep passing, which is the wrong reason to weaken a control.
--
-- The caller now states every fact it rendered from and EVERY ONE is compared against this
-- function's own authoritative read. A missing field is a mismatch, not an exemption. The caller
-- carries facts; it never carries authority, and it never computes the digest — the server does,
-- from its own read, after the comparison passes.
--
-- ── THE LOCK IS FIRST ───────────────────────────────────────────────────────────────────────
--
-- It used to sit just before the outbox existence check, by which time the claim, tenant, slot and
-- fingerprint had already been read — so a claim that moved mid-enqueue was still written under the
-- stale tenant. It is now the first statement in the function, so every authoritative read and the
-- INSERT are one decision for that claim.
--
-- ── ONE PROVIDER EFFECT PER (CLAIM, OFFER) ─────────────────────────────────────────────────
--
-- The key is `priority-claim-invite:<claim>:<offer_digest>`. A changed offer is genuinely a
-- different message, so it may be sent; an unchanged offer never can be sent twice.
--
-- A → B → A convergence is the case that needs care. Returning to offer A finds A's OWN row, which
-- was cancelled when the offer moved to B. It may be restored ONLY if it never reached the provider:
--
--   `first_dispatch_at IS NULL` AND `dispatch_authorized_generation IS NULL` AND `status <> 'sent'`
--   AND the state is `configuration_hold`.
--
-- Anything that was dispatched, attempted, or left `acceptance_uncertain` / `awaiting_reconciliation`
-- is NEVER automatically reposted or reactivated — that is the ambiguous-provider-send rule, and it
-- outranks the convenience of a manager pressing resend.

DO $d7_enqueue_contract$
DECLARE
  v_src text;
  v_new text;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'related_slot_priority_claim_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 enqueue contract: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.d7_p_invite_offer(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'D7 enqueue contract: the offer contract is not installed';
  END IF;

  EXECUTE $core$
    CREATE OR REPLACE FUNCTION public.rebook_priority_claim_invite_enqueue_core(
      p_academy     uuid,
      p_claim       uuid,
      p_round       uuid,
      p_occurred_at timestamptz,
      p_payload     jsonb,
      p_user        uuid,
      p_guest       uuid,
      p_person      uuid
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
    ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $body$
    #variable_conflict use_column
    DECLARE
      v_evt     public.notification_event_types%ROWTYPE;
      f         record;
      e         jsonb;
      v_round   uuid;
      v_idem    text;
      v_bytes   text;
      v_hash    bytea;
      v_row     uuid;
      v_state   text;
      v_ok      boolean;
      v_subject text;
      v_html    text;
      v_from    text;
      v_reply   text;
      v_grant   uuid;
    BEGIN
      IF p_academy IS NULL OR p_claim IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: tenant and claim are required'
          USING ERRCODE = '22023';
      END IF;

      -- ── THE LOCK IS THE FIRST STATEMENT ─────────────────────────────────────────────────
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('d7-invite:' || p_claim::text, 0));

      SELECT * INTO f FROM public.d7_p_invite_offer(p_academy, p_claim);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: priority claim % is not a claim of academy %',
          p_claim, p_academy USING ERRCODE = '42501';
      END IF;

      -- ── IDENTITY, AS THE CLAIM ITSELF STATES IT ─────────────────────────────────────────
      IF p_person IS NOT NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: an invitation may not carry a person id (claim %)',
          p_claim USING ERRCODE = '42501';
      END IF;
      IF f.guest_player_id IS NOT NULL THEN
        IF p_guest IS DISTINCT FROM f.guest_player_id OR p_user IS NOT NULL THEN
          RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is a guest claim and carries the guest UUID only',
            p_claim USING ERRCODE = '42501';
        END IF;
      ELSE
        IF p_guest IS NOT NULL OR f.account_user_id IS NULL OR p_user IS DISTINCT FROM f.account_user_id THEN
          RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % does not carry that profile''s own account',
            p_claim USING ERRCODE = '42501';
        END IF;
      END IF;
      IF NOT f.still_pending THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is no longer pending', p_claim
          USING ERRCODE = '42501';
      END IF;
      IF f.destination IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % has no email address to route to', p_claim
          USING ERRCODE = '42501';
      END IF;

      -- ── ONE INVITATION PER SERIES, ENFORCED HERE ────────────────────────────────────────
      --
      -- `APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`. Six routes reach this function and three of them
      -- used to carry their own leader rule; two disagreeing produced two live bearer invitations
      -- for one accept scope (closure review 6). The offer names ONE leader; a claim that is not it
      -- may not be enqueued, so a duplicate is not merely unlikely — it is unrepresentable, on every
      -- route, including ones written later by someone who never read this file.
      --
      -- Callers MAP to the leader before calling, so this refusal is a backstop, not a workflow.
      IF f.series_leader_claim_id IS DISTINCT FROM p_claim THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is not the leader of its series (that is %)',
          p_claim, f.series_leader_claim_id USING ERRCODE = '42501';
      END IF;

      -- ── THE CYCLE MUST STILL BE OPEN, BEFORE ANY WRITE ──────────────────────────────────
      --
      -- The verdict holds a closed cycle at dispatch, but by then the enqueue has committed a row
      -- and the caller has stamped `invited_at` — so the claim reads as handled while the only
      -- possible outcome is a hold. Refusing here means no row and no stamp. Keyed on the ID, not on
      -- the status being non-null: a session naming a `cycles` row that does not exist reports NULL
      -- and must not pass (`availability_slots_cyclus_id_fkey` is NOT VALID, so those rows exist).
      IF f.cyclus_id IS NOT NULL AND f.cycle_status IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % belongs to a cycle that is not open',
          p_claim USING ERRCODE = '42501';
      END IF;

      -- ── PLACEMENT COHERENCE AT BIRTH ────────────────────────────────────────────────────
      --
      -- The capture records WHICH SLOT it was for. A claim moved to another round''s slot before the
      -- enqueue would otherwise produce a row attributed to one round whose token acts on another.
      v_round := public.abc27_a_resolve_invite_round(p_academy, p_claim, p_round);
      IF v_round IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % has no round this academy may invite it for',
          p_claim USING ERRCODE = '42501';
      END IF;
      IF f.capture_slot_id IS DISTINCT FROM f.slot_id THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % sits on a session its round did not capture',
          p_claim USING ERRCODE = '42501';
      END IF;

      -- ── THE RENDERED FACTS, FIELD BY FIELD, ALL OF THEM ─────────────────────────────────
      e := p_payload -> 'd7_rendered';
      IF e IS NULL OR jsonb_typeof(e) <> 'object' THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % was enqueued without the facts it was rendered from',
          p_claim USING ERRCODE = '22023';
      END IF;
      -- PRESENT, THEN EQUAL. `->>` on a missing key yields SQL NULL, so `IS NOT DISTINCT FROM`
      -- below would accept an OMITTED field for every fact whose authoritative value happens to be
      -- null — a cycle-less, groupless, priceless session could omit nine of the fifteen and still
      -- enqueue, and a caller that rendered a price and then lost it would be accepted by the very
      -- check meant to catch that. The keys are required first; equality is asked second.
      IF NOT (e ?& ARRAY['slot_id','claim_token','group_id','cyclus_id','cyclus_name','cycle_start',
                         'payment_mode','sessions','destination','price','start','end',
                         'priority_ends','first_start','last_start','player_id']) THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % was enqueued without every fact it was rendered from',
          p_claim USING ERRCODE = '22023';
      END IF;
      v_ok :=      (e ->> 'slot_id')        IS NOT DISTINCT FROM f.slot_id::text
               -- THE PROFILE HALF, BOUND AT RENDER TIME. The digest covers it, but the digest is
               -- computed from the server's OWN read after this comparison passes — so without it
               -- here a product writer re-pointing a dual-keyed claim from (P1, G) to (P2, G)
               -- between the render and the enqueue left HTML rendered for P1 sealed against P2,
               -- and the mailed bearer token accepts pair-exactly on P2 (review round 3).
               AND (e ->> 'player_id')      IS NOT DISTINCT FROM f.player_id::text
               AND (e ->> 'claim_token')    IS NOT DISTINCT FROM f.claim_token
               AND (e ->> 'group_id')       IS NOT DISTINCT FROM f.rebook_group_id::text
               AND (e ->> 'cyclus_id')      IS NOT DISTINCT FROM f.cyclus_id::text
               AND (e ->> 'cyclus_name')    IS NOT DISTINCT FROM f.cyclus_name
               -- `::text` on a date follows the session `DateStyle`; the sender always sends
               -- ISO, so the server states ISO rather than whatever the session prefers.
               AND (e ->> 'cycle_start')    IS NOT DISTINCT FROM to_char(f.cycle_start_date, 'YYYY-MM-DD')
               AND (e ->> 'payment_mode')   IS NOT DISTINCT FROM f.payment_mode
               AND (e ->> 'sessions')       IS NOT DISTINCT FROM f.group_sessions::text
               AND (e ->> 'destination')    IS NOT DISTINCT FROM f.destination
               -- TEXT, not numeric. Comparing as numbers is what let two different roundings
               -- agree; comparing the rendered string is what makes them have to be the same.
               AND nullif(e ->> 'price', '')
                   IS NOT DISTINCT FROM to_char(f.price_per_session, 'FM999999999990.00')
               AND nullif(e ->> 'start', '')::timestamptz     IS NOT DISTINCT FROM f.start_time
               AND nullif(e ->> 'end', '')::timestamptz       IS NOT DISTINCT FROM f.end_time
               AND nullif(e ->> 'priority_ends', '')::timestamptz IS NOT DISTINCT FROM f.priority_window_ends_at
               AND nullif(e ->> 'first_start', '')::timestamptz   IS NOT DISTINCT FROM f.group_first_start
               AND nullif(e ->> 'last_start', '')::timestamptz    IS NOT DISTINCT FROM f.group_last_start;
      IF NOT v_ok THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % changed between rendering and enqueue',
          p_claim USING ERRCODE = '42501';
      END IF;

      v_subject := nullif(btrim(coalesce(p_payload->>'subject', '')), '');
      v_html    := nullif(btrim(coalesce(p_payload->>'html', '')), '');
      IF v_subject IS NULL OR v_html IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % was enqueued without a rendered subject and html',
          p_claim USING ERRCODE = '22023';
      END IF;

      -- ── ONE CLAIM, ONE TENANT ───────────────────────────────────────────────────────────
      IF EXISTS (SELECT 1 FROM public.notification_outbox o
                  WHERE o.related_slot_priority_claim_id = p_claim
                    AND o.tenant_academy_profile_id IS DISTINCT FROM p_academy) THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is already enqueued under another tenant',
          p_claim USING ERRCODE = '42501';
      END IF;

      SELECT * INTO v_evt FROM public.notification_event_types WHERE key = 'rebook_priority_claim_invite';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: the protected event type is not installed';
      END IF;

      IF public.is_email_suppressed(f.destination) THEN
        RETURN QUERY SELECT NULL::uuid, 'email'::text, 'skipped'::text, 'email_suppressed'::text,
                            v_evt.visibility_scope, NULL::text, NULL::text, NULL::text, NULL::text,
                            NULL::uuid, NULL::jsonb, v_evt.template_email, NULL::timestamptz;
        RETURN;
      END IF;

      -- ── THE FROZEN REQUEST ──────────────────────────────────────────────────────────────
      v_from  := coalesce(nullif(btrim(p_payload->>'from_name'), ''), 'PadelTrainer.ai');
      v_from  := left(regexp_replace(v_from, '[[:cntrl:]",<>\\]', '', 'g'), 120);
      IF btrim(v_from) = '' THEN v_from := 'PadelTrainer.ai'; END IF;
      v_reply := nullif(btrim(coalesce(p_payload->>'reply_to', '')), '');
      IF v_reply IS NOT NULL
         AND v_reply !~ '^[^[:space:]@,<>"]+@[^[:space:]@,<>"]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: reply_to % is not an address', v_reply
          USING ERRCODE = '22023';
      END IF;

      -- THE KEY CARRIES THE OFFER. A changed offer is a different message and may be sent; an
      -- unchanged one can never be sent twice.
      -- THE KEY IS CLAIM + ROUND + OFFER. The round is not one of the offer's TERMS — the message
      -- promises a session, a price and a deadline, not a round id — so it does not belong in the
      -- digest. It is part of WHICH INVITATION THIS IS, and it has to be in the key, because the
      -- guard consumes a transition grant against the ROW's `related_rebook_round_id` while this
      -- function issues one for the round it just resolved. A claim re-captured by a later round
      -- therefore reached the older row, and its restore was refused by a mismatch it could never
      -- resolve — the same failure on every retry, for as long as the offer stayed the same.
      -- With the round in the key that collision cannot happen: a new round is a new message.
      v_idem  := 'priority-claim-invite:' || p_claim::text || ':' || v_round::text
                 || ':' || f.offer_digest;
      v_bytes :=
        -- QUOTED, exactly as the test path quotes it. Both sides strip `"` and `\` first, so the
        -- quoting cannot nest; without it an academy called `Padel: West` produced an unquoted
        -- RFC 5322 display phrase containing a special character, which a conforming provider may
        -- reject — and only on the LIVE path, so a successful preview proved nothing.
        '{' || '"from":' || to_json('"' || v_from || '" <noreply@app.padeltrainer.ai>')::text
            || ',"to":[' || to_json(f.destination)::text
            || '],"subject":' || to_json(v_subject)::text
            || ',"html":' || to_json(v_html)::text
            || coalesce(',"reply_to":' || to_json(v_reply)::text
                        || ',"headers":{"List-Unsubscribe":'
                        || to_json('<mailto:' || v_reply || '?subject=Uitschrijven>')::text || '}', '')
            || '}';
      v_hash := pg_catalog.sha256(pg_catalog.convert_to(v_bytes, 'UTF8'));

      INSERT INTO public.notification_outbox (
        event_type, channel, occurred_at,
        recipient_user_id, recipient_person_id, recipient_guest_player_id,
        tenant_academy_profile_id, visibility_scope,
        related_rebook_round_id, related_slot_priority_claim_id,
        destination_normalized, destination_redacted,
        template_key, payload,
        idempotency_key, status, scheduled_for,
        destination_fingerprint,
        transport_state, lease_generation, request_hash, provider_idempotency_key,
        canonical_request_bytes
      ) VALUES (
        'rebook_priority_claim_invite', 'email', coalesce(p_occurred_at, clock_timestamp()),
        CASE WHEN f.guest_player_id IS NULL THEN f.account_user_id END, NULL, f.guest_player_id,
        p_academy, v_evt.visibility_scope,
        v_round, p_claim,
        f.destination, public.notification_redact_destination(f.destination, 'email'),
        v_evt.template_email,
        p_payload || jsonb_build_object('d7_offer_digest', f.offer_digest),
        v_idem, 'pending', clock_timestamp(),
        public.notif_digest_destination_fingerprint(f.destination),
        'queued', 0, v_hash, left(v_idem, 256),
        v_bytes
      )
      ON CONFLICT (channel, idempotency_key, tenant_scope_key) DO NOTHING
      RETURNING id INTO v_row;

      IF v_row IS NULL THEN
        SELECT o.id, o.transport_state INTO v_row, v_state
          FROM public.notification_outbox o
         WHERE o.channel = 'email' AND o.idempotency_key = v_idem
           AND o.tenant_scope_key = 'a:' || p_academy::text;

        -- ── A → B → A: THE SAME OFFER''S OWN ROW MAY COME BACK, IF IT NEVER LEFT ──────────
        IF v_state = 'configuration_hold'
           AND EXISTS (SELECT 1 FROM public.notification_outbox o
                        WHERE o.id = v_row
                          AND o.first_dispatch_at IS NULL
                          AND o.dispatch_authorized_generation IS NULL
                          AND o.status <> 'sent') THEN
          SELECT a.grant_id INTO v_grant
            FROM public.abc27_a_authorize_transition(
                   'transport_recovery', p_academy, v_round, p_claim, 'priority_claim',
                   v_row, 'transport_recovery', 'configuration_hold', 'queued') a;
          UPDATE public.notification_outbox o
             SET transport_state = 'queued',
                 locked_by = NULL, locked_at = NULL,
                 scheduled_for = clock_timestamp(),
                 transport_transition_action   = 'transport_recovery',
                 transport_transition_grant_id = v_grant,
                 updated_at = now()
           WHERE o.id = v_row;
          RETURN QUERY SELECT v_row, 'email'::text, 'pending'::text, 'restored'::text,
                              v_evt.visibility_scope, f.destination,
                              public.notification_redact_destination(f.destination, 'email'),
                              v_idem, NULL::text, NULL::uuid, NULL::jsonb, v_evt.template_email,
                              clock_timestamp();
          RETURN;
        END IF;

        RETURN QUERY SELECT v_row, 'email'::text, 'skipped'::text,
                            CASE WHEN v_state IS NULL OR v_state IN
                                      ('configuration_hold','acceptance_uncertain','awaiting_reconciliation')
                                 THEN 'existing_row_not_sendable' ELSE 'already_enqueued' END::text,
                            v_evt.visibility_scope, f.destination,
                            public.notification_redact_destination(f.destination, 'email'),
                            v_idem, NULL::text, NULL::uuid, NULL::jsonb, v_evt.template_email,
                            NULL::timestamptz;
        RETURN;
      END IF;

      RETURN QUERY SELECT v_row, 'email'::text, 'pending'::text, NULL::text,
                          v_evt.visibility_scope, f.destination,
                          public.notification_redact_destination(f.destination, 'email'),
                          v_idem, NULL::text, NULL::uuid, NULL::jsonb, v_evt.template_email,
                          clock_timestamp();
    END;
    $body$
  $core$;
  EXECUTE format('ALTER FUNCTION public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid) OWNER TO %I',
    (SELECT c.relowner::regrole::name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname='notification_outbox'));
  EXECUTE 'REVOKE ALL ON FUNCTION public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';

  -- ══ PROVED FROM THE CATALOG ══════════════════════════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) INTO v_src;
  -- The lock precedes the first authoritative read, not merely the outbox check.
  IF position('pg_advisory_xact_lock' IN v_src) = 0
     OR position('pg_advisory_xact_lock' IN v_src) > position('d7_p_invite_offer' IN v_src) THEN
    RAISE EXCEPTION 'D7 enqueue contract: the lock does not precede the first authoritative read';
  END IF;
  -- The rendered facts are compared unconditionally: no `IS NOT NULL AND` guard may stand in front
  -- of the comparison, which is exactly how the previous version became optional.
  IF position('d7_rendered' IN v_src) = 0
     OR position(E'was enqueued without the facts it was rendered from' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: the rendered-fact binding is not mandatory';
  END IF;
  IF position('|| f.offer_digest' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: the idempotency key does not carry the offer';
  END IF;
  -- ...and the round, without which a re-captured claim collides with a row whose restore grant can
  -- never be consumed. Named here so that removing it from the key is a refusal, not a regression.
  IF position('|| v_round::text' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: the idempotency key does not carry the round';
  END IF;
  -- The convergence invariants, named where they live.
  IF position('f.series_leader_claim_id IS DISTINCT FROM p_claim' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: a non-leader claim could be enqueued';
  END IF;
  IF position('f.cyclus_id IS NOT NULL AND f.cycle_status IS DISTINCT FROM ''open''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: a closed cycle could be enqueued and stamped';
  END IF;
  IF position(E'to_json(''"'' || v_from || ''" <noreply@app.padeltrainer.ai>'')' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: the From display phrase is not quoted';
  END IF;
  IF position('o.first_dispatch_at IS NULL' IN v_src) = 0
     OR position('o.dispatch_authorized_generation IS NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 enqueue contract: a row that reached the provider could be restored';
  END IF;

  RAISE NOTICE 'D7: one provider effect per claim and complete offer';
END $d7_enqueue_contract$;
