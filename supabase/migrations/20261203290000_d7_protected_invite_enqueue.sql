-- D7 RUNTIME — THE PROTECTED INVITATION ENQUEUE.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_PROTECTED_ENQUEUE_AND_FINAL_CLOSURE_V1`):
--   `OPTION_2_EXTEND_THE_EXISTING_enqueue_notification_MACHINE_ENTRYPOINT_TO_INITIALIZE_TRANSPORT`
--   `ENTRYPOINTS=REMAIN_EXACTLY_NINE_NO_NEW_RUNTIME_ROLE_GRANT_OR_ENTRYPOINT`
--   `PRODUCT=RETAIN_MANAGER_TRIGGERED_INVITATION_FLOW`
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────────────────────
--
-- `20261203260000`–`20261203280000` made an invitation a first-class transport subject, and nothing
-- could put one into the transport: `rebook_member_open_enqueue_core` is the only routine that
-- initializes `transport_state`, and it is revoked from `service_role`. `enqueue_notification` — the
-- one enqueue the machine role reaches — never touched a transport column.
--
-- This file closes that, and ONLY for the one closed event type. The branch is written the way
-- ABC-27 wrote the refusal beside it: an explicit equality on a single literal event key, so a
-- second protected type cannot acquire transport initialization by resembling this one.
--
-- ── WHY A PRIVATE CORE, AND WHY THAT IS NOT A TENTH ENTRYPOINT ─────────────────────────────
--
-- The invitation shares nothing with the generic resolver: its recipient comes from a priority
-- claim, its address follows the product's own guest-then-profile rule, and it has no preference or
-- digest arm. Inlining that into `enqueue_notification` would have interleaved two unrelated
-- policies in one body.
--
-- So it lives in `rebook_priority_claim_invite_enqueue_core`, owned by Domain N and revoked from
-- PUBLIC, anon, authenticated AND service_role — exactly the negative space
-- `rebook_member_open_enqueue_core` occupies. An entrypoint is a routine the MACHINE ROLE can call;
-- this one it cannot. The machine surface stays at nine, and the contract test pins that by NAME so
-- a stray grant here fails rather than passes.
--
-- ── THE ADDRESS RULE ────────────────────────────────────────────────────────────────────────
--
-- A guest claim routes to the GUEST'S OWN address and nowhere else; a profile claim routes to that
-- profile's. There is deliberately no fallback between them.
--
-- That is the shipped sender's rule, traced rather than assumed: it resolves a guest through
-- `guestContactEmail`, which reads `own_email` from `resolve_guest_member_contacts`, which ABC-16/17
-- reduced to `nullif(btrim(guest_players.email), '')` — own attributes only, because no legacy
-- relationship evidence establishes an account for a guest. A draft of this file used
-- `guest ?? profile`, copied from `personContactEmail`; that helper is used by a DIFFERENT caller,
-- and following it here would have mailed a child's invitation to the linked parent's inbox — the
-- exact defect the sender's own comment says it was changed to stop doing.
--
-- So this bridge agrees with `d7_p_invite_recipient_snapshot.has_contact` exactly. It exists beside
-- it because that one answers WHETHER a claim is reachable and this one answers WHERE — a boolean
-- and an address are not the same question, and the enqueue needs the address.

DO $d7_invite_enqueue$
DECLARE
  v_n       name;
  v_p       name;
  v_src     text;
  v_new     text;
  v_acl_old text[];
  v_acl_new text[];
  v_owner   name;
  v_a       name;
  v_ident   CONSTANT text :=
    'public.enqueue_notification(text,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid,text,text,jsonb,jsonb,timestamptz,timestamptz,uuid,uuid,text)';
  v_new_ident CONSTANT text :=
    'public.enqueue_notification(text,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid,text,text,jsonb,jsonb,timestamptz,timestamptz,uuid,uuid,text,uuid)';
  v_hits    int;
  v_item    text;
  -- AS `pg_get_functiondef` RENDERS IT, not as the source file writes it: one line, and every
  -- default explicitly cast (`NULL::text`). Anchoring on the source form matched nothing.
  c_sig_old CONSTANT text := 'p_terminal_skip_reason text DEFAULT NULL::text)';
  c_sig_new CONSTANT text := 'p_terminal_skip_reason text DEFAULT NULL::text, p_related_slot_priority_claim_id uuid DEFAULT NULL::uuid)';
  -- ABC-27's own refusal for the other protected type. Anchoring on it puts the delegation exactly
  -- where the reader already expects event-specific dispatch to live, and guarantees the branch runs
  -- BEFORE the generic event lookup and every policy arm below it.
  c_anchor CONSTANT text :=
    E'  IF p_event_key = ''rebook_member_open_player'' THEN\n';
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR to_regprocedure('public.rebook_round_transport_subject_domains()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'related_slot_priority_claim_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 invite enqueue: prerequisites absent — skipping';
    RETURN;
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';
  SELECT c.relowner::regrole::name INTO v_p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='cycles';
  IF v_n IS NULL OR v_p IS NULL THEN
    RAISE EXCEPTION 'D7 invite enqueue: cannot resolve the Domain-N/Domain-P owners';
  END IF;

  -- ══ 0 · THE TWO CONSTRAINTS THAT SCOPE TRANSPORT TO ONE EVENT TYPE ══════════════════════
  --
  -- Found by trying to insert, not by reading. `20261203260000`–`20261203280000` made an invitation
  -- a transport subject everywhere EXCEPT here:
  --
  --   `chk_notification_outbox_transport_scope`     — only member-open may carry transport state at
  --     all; every other event type must have all five transport columns NULL.
  --   `chk_notification_outbox_transition_action`   — only member-open may present a transition
  --     action, which is what `begin_dispatch` and `record_dispatch_outcome` stamp on every UPDATE.
  --
  -- The first blocks the enqueue outright; the second would have let the row be created and then
  -- refused every transition it ever attempted — the worse of the two failures, because it appears
  -- only once a dispatch is tried.
  --
  -- Both are widened to the protected SET, and both keep every other arm verbatim: the transport
  -- columns still must be NULL for anything outside that set, and an action still must come from
  -- `rebook_round_transport_actions()`. The vocabulary function is Domain-N owned and every writer
  -- of this table is an N-owned definer, so no cross-owner EXECUTE grant is needed.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = to_regclass('public.notification_outbox')
                    AND conname = 'chk_notification_outbox_transport_scope'
                    AND pg_get_constraintdef(oid) LIKE '%protected_event_types%') THEN
    EXECUTE 'ALTER TABLE public.notification_outbox DROP CONSTRAINT chk_notification_outbox_transport_scope';
    EXECUTE $c1$
      ALTER TABLE public.notification_outbox
        ADD CONSTRAINT chk_notification_outbox_transport_scope
        CHECK (
          event_type = ANY (public.rebook_round_protected_event_types())
          OR (transport_state IS NULL
              AND leased_from_state IS NULL
              AND dispatch_authorized_generation IS NULL
              AND first_dispatch_at IS NULL
              AND uncertainty_deadline_at IS NULL)
        ) NOT VALID
    $c1$;
    EXECUTE 'ALTER TABLE public.notification_outbox VALIDATE CONSTRAINT chk_notification_outbox_transport_scope';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = to_regclass('public.notification_outbox')
                    AND conname = 'chk_notification_outbox_transition_action'
                    AND pg_get_constraintdef(oid) LIKE '%protected_event_types%') THEN
    EXECUTE 'ALTER TABLE public.notification_outbox DROP CONSTRAINT chk_notification_outbox_transition_action';
    EXECUTE $c2$
      ALTER TABLE public.notification_outbox
        ADD CONSTRAINT chk_notification_outbox_transition_action
        CHECK (
          transport_transition_action IS NULL
          OR (event_type = ANY (public.rebook_round_protected_event_types())
              AND transport_transition_action = ANY (public.rebook_round_transport_actions()))
        ) NOT VALID
    $c2$;
    EXECUTE 'ALTER TABLE public.notification_outbox VALIDATE CONSTRAINT chk_notification_outbox_transition_action';
  END IF;

  -- PROVED FROM THE CATALOG. Each retained arm is named, so a widening that dropped one — which
  -- would silently let ANY event type carry transport state — fails here rather than shipping.
  SELECT pg_get_constraintdef(oid) INTO v_src FROM pg_catalog.pg_constraint
   WHERE conrelid = to_regclass('public.notification_outbox') AND conname = 'chk_notification_outbox_transport_scope';
  IF v_src IS NULL
     OR position('protected_event_types' IN v_src) = 0
     OR position('transport_state IS NULL' IN v_src) = 0
     OR position('leased_from_state IS NULL' IN v_src) = 0
     OR position('dispatch_authorized_generation IS NULL' IN v_src) = 0
     OR position('first_dispatch_at IS NULL' IN v_src) = 0
     OR position('uncertainty_deadline_at IS NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite enqueue: chk_notification_outbox_transport_scope lost an arm (actual: %)', coalesce(v_src,'<missing>');
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_src FROM pg_catalog.pg_constraint
   WHERE conrelid = to_regclass('public.notification_outbox') AND conname = 'chk_notification_outbox_transition_action';
  IF v_src IS NULL
     OR position('protected_event_types' IN v_src) = 0
     OR position('rebook_round_transport_actions' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite enqueue: chk_notification_outbox_transition_action lost an arm (actual: %)', coalesce(v_src,'<missing>');
  END IF;

  -- ══ 1 · THE ROUTING BRIDGE — SELECT ONLY, TENANT FENCED ═══════════════════════════════════
  EXECUTE $bridge$
    CREATE OR REPLACE FUNCTION public.d7_p_invite_contact(p_academy uuid, p_claim uuid)
    RETURNS TABLE (
      claim_id        uuid,
      player_id       uuid,
      guest_player_id uuid,
      destination     text,
      still_pending   boolean
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $sn$
      SELECT c.id, c.player_id, c.guest_player_id,
             CASE
               WHEN c.guest_player_id IS NOT NULL THEN
                 (SELECT nullif(btrim(g.email), '') FROM public.guest_players g WHERE g.id = c.guest_player_id)
               ELSE
                 (SELECT nullif(btrim(pr.email), '') FROM public.profiles pr WHERE pr.id = c.player_id)
             END,
             coalesce(c.status, 'pending') = 'pending'
        FROM public.slot_priority_claims c
        JOIN public.availability_slots s ON s.id = c.slot_id
       WHERE c.id = p_claim
         AND s.academy_profile_id = p_academy
    $sn$
  $bridge$;
  EXECUTE format('ALTER FUNCTION public.d7_p_invite_contact(uuid,uuid) OWNER TO %I', v_p);
  EXECUTE 'REVOKE ALL ON FUNCTION public.d7_p_invite_contact(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_invite_contact(uuid,uuid) TO %I', v_n);

  -- ══ 1b · THE ROUND A CLAIM BELONGS TO ═══════════════════════════════════════════════════
  --
  -- THREE LIVE CALLERS SEND NO ROUND: the per-claim re-invite and the invite-everyone-on-this-slot
  -- button in `PriorityClaimsSection` (both slot-detail pages), and `notifyPriorityClaimsForSlots`
  -- from the bulk-copy wizard. A protected invitation cannot exist without a round, so either they
  -- break or the round is derived.
  --
  -- IT HAS TO BE DERIVED HERE, not in the edge. `rebook_round_recipient_claim_sources` is a
  -- DOMAIN-A relation, and no ABC-27 round table appears in the generated Supabase types — edge code
  -- does not read them, by convention and because the types would not know them. A first version of
  -- the cutover read the table from the edge and failed exactly that check.
  --
  -- So this is an A-owned reader granted to Domain N and to nobody else, which is the shape ABC-27
  -- already uses for every A fact the N-owned writers need (`abc27_a_member_snapshot` and its
  -- siblings are granted to `v_n` by the same loop). No new role, no new runtime grant, no new
  -- entrypoint — the same permission class, one more member.
  --
  -- A claim may source more than one round (`uq_rrrcs_claim_per_round` is unique PER ROUND), so the
  -- most recently captured one wins: re-inviting a claim means re-inviting it for the round it is
  -- currently part of, not the first one it ever belonged to.
  EXECUTE $cr$
    CREATE OR REPLACE FUNCTION public.abc27_a_claim_round(p_academy uuid, p_claim uuid)
    RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $cb$
      SELECT s.rebook_round_id
        FROM public.rebook_round_recipient_claim_sources s
       WHERE s.source_claim_id = p_claim
         AND s.academy_profile_id = p_academy
       ORDER BY s.captured_at DESC
       LIMIT 1
    $cb$
  $cr$;
  SELECT c.relowner::regrole::name INTO v_a
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'rebook_round_recipient_claim_sources';
  IF v_a IS NULL THEN
    RAISE EXCEPTION 'D7 invite enqueue: cannot resolve the Domain-A owner';
  END IF;
  EXECUTE format('ALTER FUNCTION public.abc27_a_claim_round(uuid,uuid) OWNER TO %I', v_a);
  EXECUTE 'REVOKE ALL ON FUNCTION public.abc27_a_claim_round(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.abc27_a_claim_round(uuid,uuid) TO %I', v_n);

  -- ══ 2 · THE PRIVATE INVITATION ENQUEUE CORE ══════════════════════════════════════════════
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
    -- THE RETURNS TABLE NAMES ARE OUT PARAMETERS, and `channel`, `status`, `template_key` and
    -- friends are also columns of `notification_outbox` — so the INSERT below is ambiguous without
    -- this. Same directive, for the same reason, as `enqueue_notification` itself. Every local here
    -- is `v_`-prefixed, so nothing else can be captured by it.
    #variable_conflict use_column
    DECLARE
      v_evt        public.notification_event_types%ROWTYPE;
      v_claim      uuid;
      v_player     uuid;
      v_guest      uuid;
      v_dest       text;
      v_pending    boolean;
      v_user       uuid;
      v_idem       text;
      v_bytes      text;
      v_hash       bytea;
      v_row        uuid;
      v_subject    text;
      v_html       text;
      v_round      uuid;
      v_from_name  text;
      v_reply      text;
    BEGIN
      -- ── REFUSE BEFORE ANY WRITE ───────────────────────────────────────────────────────────
      --
      -- `MISSING_MISMATCHED_OR_FOREIGN_CLAIM_FACTS_REFUSE_BEFORE_ANY_OUTBOX_OR_TRANSPORT_WRITE`.
      -- Every check below runs before the single INSERT at the end, so a refusal leaves no outbox
      -- row, no transport state and no partial identity behind.
      IF p_academy IS NULL OR p_claim IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: tenant and claim are required'
          USING ERRCODE = '22023';
      END IF;

      SELECT b.claim_id, b.player_id, b.guest_player_id, b.destination, b.still_pending
        INTO v_claim, v_player, v_guest, v_dest, v_pending
        FROM public.d7_p_invite_contact(p_academy, p_claim) b;
      -- FOREIGN OR ABSENT. The bridge is fenced by academy, so another tenant's claim simply is not
      -- there — the refusal is relational, not a secrecy assumption about the UUID.
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: priority claim % is not a claim of academy %',
          p_claim, p_academy USING ERRCODE = '42501';
      END IF;

      -- THE ROUND, SUPPLIED OR DERIVED — and only now, once the claim is PROVEN to be this
      -- academy's. The wizard knows the round it just created and passes it; the per-claim and
      -- per-slot invite buttons do not, and the claim itself records which round it was captured
      -- for. Deriving before the tenancy check would have answered a foreign claim with "belongs to
      -- no rebook round" — true, but the wrong refusal, and a less useful one.
      --
      -- A claim belonging to NO round cannot be a protected invitation, and is refused rather than
      -- sent some other way: an untracked send is the thing this path exists to remove, so there is
      -- deliberately no fallback.
      v_round := coalesce(p_round, public.abc27_a_claim_round(p_academy, p_claim));
      IF v_round IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % belongs to no rebook round', p_claim
          USING ERRCODE = '42501';
      END IF;

      -- THE CALLER'S STATED IDENTITY MUST BE THE CLAIM'S OWN. The outbox guard enforces this again
      -- at INSERT; it is enforced here too so the refusal names the claim rather than surfacing as a
      -- constraint violation from three layers down.
      IF p_person IS NOT NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: an invitation may not carry a person id (claim %)',
          p_claim USING ERRCODE = '42501';
      END IF;
      IF v_guest IS NOT NULL THEN
        IF p_guest IS DISTINCT FROM v_guest OR p_user IS NOT NULL THEN
          RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is a guest claim and carries the guest UUID only',
            p_claim USING ERRCODE = '42501';
        END IF;
        v_user := NULL;
      ELSE
        IF p_guest IS NOT NULL THEN
          RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is a profile claim and may not carry a guest',
            p_claim USING ERRCODE = '42501';
        END IF;
        SELECT pr.user_id INTO v_user FROM public.profiles pr WHERE pr.id = v_player;
        IF v_user IS NULL OR p_user IS DISTINCT FROM v_user THEN
          RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % does not carry that profile''s own account',
            p_claim USING ERRCODE = '42501';
        END IF;
      END IF;

      -- ELIGIBILITY. A claim that is no longer pending has been decided; inviting it again would
      -- contradict the decision. This is the caller's to know, so it is a refusal, not a skip.
      IF NOT v_pending THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % is no longer pending', p_claim
          USING ERRCODE = '42501';
      END IF;
      IF v_dest IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % has no email address to route to', p_claim
          USING ERRCODE = '42501';
      END IF;

      -- THE RENDERED BODY. `rebook_priority_claim_invite` carries a NULL `trusted_payload_builder`,
      -- which is what lets the sender that owns the invitation template pass the body it rendered.
      -- It must actually pass one: bytes are frozen from these two fields and a missing one would
      -- freeze an empty request under a real idempotency key.
      v_subject := nullif(btrim(coalesce(p_payload->>'subject', '')), '');
      v_html    := nullif(btrim(coalesce(p_payload->>'html', '')), '');
      IF v_subject IS NULL OR v_html IS NULL THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: claim % was enqueued without a rendered subject and html',
          p_claim USING ERRCODE = '22023';
      END IF;

      SELECT * INTO v_evt FROM public.notification_event_types WHERE key = 'rebook_priority_claim_invite';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: the protected event type is not installed';
      END IF;

      -- SUPPRESSION IS A SKIP, NOT A REFUSAL — it is the one thing the sender cannot know, and a
      -- bounced address is not a caller error.
      IF public.is_email_suppressed(v_dest) THEN
        RETURN QUERY SELECT NULL::uuid, 'email'::text, 'skipped'::text, 'email_suppressed'::text,
                            v_evt.visibility_scope, NULL::text, NULL::text, NULL::text, NULL::text,
                            NULL::uuid, NULL::jsonb, v_evt.template_email, NULL::timestamptz;
        RETURN;
      END IF;

      -- ── THE FROZEN REQUEST IDENTITY ───────────────────────────────────────────────────────
      --
      -- THESE BYTES ARE THE PROVIDER REQUEST BODY, not a digest input: the worker POSTs
      -- `canonical_request_bytes` verbatim. So everything the invitation needs on the wire has to be
      -- here, and a first version that copied member-open's four fields would have silently stripped
      -- the academy branding, the reply-to and the List-Unsubscribe header the shipped sender sets.
      --
      -- THE ENVELOPE STAYS UNDER THIS FUNCTION'S CONTROL even though the body is rendered upstream.
      -- The caller may choose a DISPLAY NAME; it may not choose the address, so no academy can send
      -- as another. Control characters and the quoting metacharacters of RFC 5322 are stripped, and
      -- a reply-to must look like an address before it is echoed into a header.
      --
      -- Field order is fixed and the optional tail is all-or-nothing, so the same inputs always
      -- produce the same bytes — which is what makes the hash a stable identity.
      v_from_name := coalesce(nullif(btrim(p_payload->>'from_name'), ''), 'PadelTrainer.ai');
      v_from_name := left(regexp_replace(v_from_name, '[[:cntrl:]"<>\\]', '', 'g'), 120);
      IF btrim(v_from_name) = '' THEN v_from_name := 'PadelTrainer.ai'; END IF;
      v_reply := nullif(btrim(coalesce(p_payload->>'reply_to', '')), '');
      IF v_reply IS NOT NULL
         AND v_reply !~ '^[^[:space:]@,<>"]+@[^[:space:]@,<>"]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'rebook_priority_claim_invite_enqueue_core: reply_to % is not an address', v_reply
          USING ERRCODE = '22023';
      END IF;

      v_idem  := 'priority-claim-invite:' || p_claim::text;
      v_bytes :=
        '{' || '"from":' || to_json(v_from_name || ' <noreply@app.padeltrainer.ai>')::text
            || ',"to":[' || to_json(v_dest)::text
            || '],"subject":' || to_json(v_subject)::text
            || ',"html":' || to_json(v_html)::text
            || coalesce(',"reply_to":' || to_json(v_reply)::text
                        || ',"headers":{"List-Unsubscribe":'
                        || to_json('<mailto:' || v_reply || '?subject=Uitschrijven>')::text || '}', '')
            || '}';
      v_hash := pg_catalog.sha256(pg_catalog.convert_to(v_bytes, 'UTF8'));

      -- ── ONE STATEMENT: THE ROW AND ITS TRANSPORT STATE ────────────────────────────────────
      --
      -- Atomic by construction rather than by ordering. A row that existed for even one statement
      -- without `transport_state` would be invisible to the D7 claimer and excluded from the generic
      -- ones — a permanently stranded invitation that no janitor owns.
      --
      -- ON CONFLICT names all THREE columns of `uq_notification_outbox_idem`: `20261015100000` made
      -- it `(channel, idempotency_key, tenant_scope_key)`, and `tenant_scope_key` is GENERATED.
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
        v_user, NULL, v_guest,
        p_academy, v_evt.visibility_scope,
        v_round, p_claim,
        v_dest, public.notification_redact_destination(v_dest, 'email'),
        v_evt.template_email, p_payload,
        v_idem, 'pending', clock_timestamp(),
        public.notif_digest_destination_fingerprint(v_dest),
        'queued', 0, v_hash, left(v_idem, 256),
        v_bytes
      )
      ON CONFLICT (channel, idempotency_key, tenant_scope_key) DO NOTHING
      RETURNING id INTO v_row;

      IF v_row IS NULL THEN
        -- ALREADY ENQUEUED, PERMANENTLY. This is the durable no-duplicate authority that replaces
        -- reliance on the provider's 24-hour window: the row is the record, and it does not expire.
        SELECT o.id INTO v_row FROM public.notification_outbox o
         WHERE o.channel = 'email' AND o.idempotency_key = v_idem
           AND o.tenant_scope_key = 'a:' || p_academy::text;
        RETURN QUERY SELECT v_row, 'email'::text, 'skipped'::text, 'already_enqueued'::text,
                            v_evt.visibility_scope, v_dest, public.notification_redact_destination(v_dest, 'email'),
                            v_idem, NULL::text, NULL::uuid, NULL::jsonb, v_evt.template_email,
                            NULL::timestamptz;
        RETURN;
      END IF;

      RETURN QUERY SELECT v_row, 'email'::text, 'pending'::text, NULL::text,
                          v_evt.visibility_scope, v_dest, public.notification_redact_destination(v_dest, 'email'),
                          v_idem, NULL::text, NULL::uuid, NULL::jsonb, v_evt.template_email,
                          clock_timestamp();
    END;
    $body$
  $core$;
  EXECUTE format('ALTER FUNCTION public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid) OWNER TO %I', v_n);
  -- THE SAME NEGATIVE SPACE `rebook_member_open_enqueue_core` OCCUPIES. Not service_role — an
  -- entrypoint is what the machine role can call, and this is not one.
  EXECUTE 'REVOKE ALL ON FUNCTION public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';

  -- ══ 3 · THE ENTRYPOINT GAINS THE CLAIM AND THE BRANCH ════════════════════════════════════
  IF to_regprocedure(v_ident) IS NOT NULL THEN
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[]),
           p.proowner::regrole::name
      INTO v_acl_old, v_owner
      FROM pg_catalog.pg_proc p LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
     WHERE p.oid = to_regprocedure(v_ident)
     GROUP BY p.proowner;

    v_hits := (length(v_src) - length(replace(v_src, c_sig_old, ''))) / length(c_sig_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'D7 invite enqueue: the entrypoint signature tail appears % time(s), expected exactly 1', v_hits;
    END IF;
    v_hits := (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'D7 invite enqueue: the member-open dispatch anchor appears % time(s), expected exactly 1', v_hits;
    END IF;

    v_new := replace(v_src, c_sig_old, c_sig_new);
    v_new := replace(v_new, c_anchor,
      E'  IF p_event_key = ''rebook_priority_claim_invite'' THEN\n'
      '    -- THE ONE PROTECTED TYPE THIS ENTRYPOINT MAY INITIALIZE TRANSPORT FOR. An exact equality\n'
      '    -- on a single literal, deliberately not a membership test against the protected SET: a\n'
      '    -- second protected type must be a reviewed decision, not an inherited one.\n'
      '    RETURN QUERY SELECT * FROM public.rebook_priority_claim_invite_enqueue_core(\n'
      '      p_tenant_academy_profile_id, p_related_slot_priority_claim_id, p_related_rebook_round_id,\n'
      '      v_occurred, p_payload, p_recipient_user_id, p_recipient_guest_player_id, p_recipient_person_id);\n'
      '    RETURN;\n'
      '  END IF;\n'
      || c_anchor);

    -- The old signature must GO, not linger as an overload: every existing 18-argument call would
    -- otherwise be ambiguous against the 19-argument one whose tail is defaulted. This is the same
    -- drop-then-recreate ABC-27 itself used when it appended four parameters here.
    EXECUTE format('DROP FUNCTION %s', v_ident);
    EXECUTE v_new;

    IF v_owner IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_new_ident, v_owner);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_new_ident);
    IF v_acl_old IS NOT NULL THEN
      FOREACH v_item IN ARRAY v_acl_old LOOP
        IF position('X' IN split_part(split_part(v_item, '/', 1), '=', 2)) > 0 THEN
          IF split_part(v_item, '=', 1) = '' THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', v_new_ident);
          ELSE
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_new_ident, split_part(v_item, '=', 1));
          END IF;
        END IF;
      END LOOP;
    END IF;

    SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[])
      INTO v_acl_new
      FROM pg_catalog.pg_proc p LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
     WHERE p.oid = to_regprocedure(v_new_ident);
    IF v_acl_old IS DISTINCT FROM v_acl_new THEN
      RAISE EXCEPTION 'D7 invite enqueue: the entrypoint ACL restore is not byte-equivalent (before=% after=%)',
        v_acl_old, v_acl_new;
    END IF;
    RAISE NOTICE 'D7 invite enqueue: entrypoint re-created, owner=%, acl=%', v_owner, v_acl_new;
  END IF;

  -- PROVED FROM THE CATALOG. The generic refusal for the OTHER protected type must survive: this
  -- file inserts its branch beside that one, and a substitution that replaced it instead would have
  -- made member-open generically enqueueable.
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_new_ident)) INTO v_src;
  IF position('is owned by its private event-specific authority' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite enqueue: the member-open generic refusal was lost';
  END IF;
  IF position('rebook_priority_claim_invite_enqueue_core' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite enqueue: the entrypoint did not take the invitation branch';
  END IF;

  RAISE NOTICE 'D7: an invitation can now enter the transport, and only through this one branch';
END $d7_invite_enqueue$;
