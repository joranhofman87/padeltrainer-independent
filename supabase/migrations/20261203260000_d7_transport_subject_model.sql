-- D7 RUNTIME — ONE CLOSED TRANSPORT SUBJECT, ACROSS BOTH AUTHORITY TABLES.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_TRANSPORT_SUBJECT_GENERALIZATION_AND_CANONICAL_OUTBOX_CLOSURE_V1`):
--   `MODEL=OPTION_A_ONE_CLOSED_SUBJECT_TRIPLE_ACROSS_OPERATION_TARGETS_AND_TRANSPORT_TRANSITIONS`
--   `SUBJECT_VOCABULARY=EXACT_SNAPSHOT_MEMBER_AND_PRIORITY_CLAIM_TRANSPORT_DOMAINS_ONLY`
--   `NO_FOREIGN_KEY_ON_NEW_OR_RESHAPED_SUBJECT_COLUMNS=YES`
--
-- ── WHY THIS FILE REPLACES `d7_transport_vocabulary_widening` ────────────────────────────────
--
-- The file that stood at this version widened seven routines it called "the event-blind transport",
-- on the premise that their `event_type` test was the ONLY thing tying them to member-open. That
-- premise was measured and is FALSE. All seven read `notification_outbox.related_rebook_round_-
-- recipient_id`, and five of them go further:
--
--   claim_batch              → filters on `abc27_a_member_decided(...)`
--   record_dispatch_outcome  → `abc27_a_write_decision` / `abc27_a_write_incident`
--   close_unresolved         → `abc27_a_member_decided`, `abc27_a_write_decision`, `issue_delete_pair`
--
-- `rebook_round_recipient_decisions` carries a COMPOSITE FOREIGN KEY
-- `(rebook_round_recipient_id, rebook_round_id, academy_profile_id) → rebook_round_recipients`. An
-- invitation has no `rebook_round_recipients` row, so it can never have a decision row. Widening the
-- event test alone would have let `close_unresolved` pull an invitation into a decision write and
-- abort the whole batch — taking the member-open rows in that batch down with it. Widening without
-- a subject is not a smaller step toward this design; it is a strictly worse state than not widening.
--
-- So the widening moves into `20261203270000`, where subject resolution exists to make it true, and
-- this file establishes the subject the routines there resolve.
--
-- ── WHY AN INVITATION NEEDS ITS OWN COLUMN ──────────────────────────────────────────────────
--
-- `related_rebook_round_recipient_id` cannot be reused to carry a claim: it is one leg of the
-- composite FK above. Pointing it at a claim id would violate that FK, and dropping the FK would
-- discard the tenant-coherence guarantee it exists to provide.
--
-- The new column therefore carries the claim, and carries it with NO foreign key of its own — which
-- is the point, not an omission. A claim is deleted by the shipped guest-merge path; an FK would
-- either cascade that deletion into transport state or block the merge on a lock the merge never
-- manifested. The subject is a canonical immutable UUID, and the transport's correctness must not
-- depend on the row it names still existing.
--
-- Exclusivity is enforced ADDITIVELY, by a new constraint, rather than by editing the pinned
-- `chk_notification_outbox_rebook_member_open_shape`: the owner's `FROZEN_SUITE` allowance covers
-- the `uq_rrtt` and `chk_rrot` pins and nothing else, and this achieves the same guarantee inside it.

DO $d7_subject_model$
DECLARE
  v_pre     int;
  v_foreign int;
  v_def     text;
  v_owner_a name;
  v_owner_n name;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR to_regclass('public.rebook_round_transport_transitions') IS NULL
     OR to_regclass('public.rebook_round_operation_targets') IS NULL
     OR to_regprocedure('public.rebook_round_protected_event_types()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 subject model: prerequisites absent — skipping';
    RETURN;
  END IF;

  -- ── THE CLOSED VOCABULARY ─────────────────────────────────────────────────────────────────
  --
  -- Created INSIDE the guarded block. Every post-ABC-27 file in this lineage is required to put all
  -- of its executable text behind the prerequisite guard, so a file applied against a database that
  -- never got ABC-27 leaves nothing at all behind — not even a harmless function.
  --
  -- Deliberately NOT `rebook_round_subject_types()`. That vocabulary is `profile|auth_user|guest` —
  -- PERSON identities. A priority claim is not a person, and adding it there would silently change
  -- what every other caller of that function means by "subject".
  EXECUTE $vocab$
    CREATE OR REPLACE FUNCTION public.rebook_round_transport_subject_domains()
    RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $body$
      SELECT ARRAY['snapshot_member','priority_claim']::text[]
    $body$
  $vocab$;
  -- The event type → subject domain map. Total over the protected set and NOTHING else: an event
  -- type outside `rebook_round_protected_event_types()` returns NULL, and every caller treats NULL
  -- as a refusal rather than as a default. That is what keeps the vocabulary closed at the only
  -- place where an open-ended one could creep in.
  EXECUTE $vocab$
    CREATE OR REPLACE FUNCTION public.rebook_round_transport_subject_domain_for_event(p_event_type text)
    RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $body$
      SELECT CASE p_event_type
               WHEN 'rebook_member_open_player'    THEN 'snapshot_member'
               WHEN 'rebook_priority_claim_invite' THEN 'priority_claim'
               ELSE NULL
             END
    $body$
  $vocab$;
  -- ── OWNERSHIP INSTEAD OF A CROSS-OWNER GRANT ──────────────────────────────────────────────
  --
  -- ABC-27 states the rule for its own vocabularies, and states why: a function whose CHECKs and
  -- callers live in ONE domain is OWNED by that domain and "needs no grant to anyone", while
  -- `rebook_round_transport_actions` and `rebook_round_transport_states` are deliberately left
  -- unowned by either — their CHECKs sit on an A relation AND on the Domain-N outbox, and closing
  -- that needs a cross-owner EXECUTE grant ABC-27 was not authorized to add.
  --
  -- These two split cleanly along that line, which is why neither needs such a grant:
  --
  --   `_domains()`          — called by `abc27_a_authorize_transition` and by the CHECK on
  --                           `rebook_round_transport_transitions`. Both are Domain A. → owned by A.
  --   `_domain_for_event()` — called by the machine entrypoints that read the outbox, and by nothing
  --                           in Domain A, because A never derives the domain (it has no grant on
  --                           `notification_outbox` and must be TOLD). → owned by Domain N.
  --
  -- Owners are resolved from the CATALOG, via a relation each domain indisputably owns, rather than
  -- from a hardcoded role name that would drift if the install ever chose different ones.
  SELECT c.relowner::regrole::name INTO v_owner_a
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'rebook_round_transport_transitions';
  SELECT c.relowner::regrole::name INTO v_owner_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'notification_outbox';
  IF v_owner_a IS NULL OR v_owner_n IS NULL THEN
    RAISE EXCEPTION 'D7 subject model: cannot resolve the Domain-A/Domain-N owners from the catalog';
  END IF;
  EXECUTE format('ALTER FUNCTION public.rebook_round_transport_subject_domains() OWNER TO %I', v_owner_a);
  EXECUTE format('ALTER FUNCTION public.rebook_round_transport_subject_domain_for_event(text) OWNER TO %I', v_owner_n);
  -- Same privilege surface as every other ABC-27 vocabulary function — owner-only, and no new
  -- runtime role or permission class, per `SECURITY=`. The REVOKE comes AFTER the owner change
  -- because `ALTER FUNCTION ... OWNER TO` rewrites the ACL's owner entries.
  EXECUTE 'REVOKE ALL ON FUNCTION public.rebook_round_transport_subject_domains() FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.rebook_round_transport_subject_domain_for_event(text) FROM PUBLIC, anon, authenticated, service_role';

  -- ══ COMPATIBILITY, PROVED BEFORE ANYTHING IS RESHAPED ═════════════════════════════════════
  --
  -- `COMPATIBILITY=ASSERT_ALL_PREEXISTING_TRANSITIONS_ARE_SNAPSHOT_MEMBER_BEFORE_RESHAPE`.
  --
  -- The backfill below is a DEFAULT, and a default is only unambiguous if every existing row really
  -- is a snapshot member. That is argued from the fact that member-open was the only event type with
  -- transport — but an argument is not a proof, so it is measured here and the migration refuses if
  -- the measurement disagrees. A row whose outbox row is already gone can only ever have been
  -- member-open, since no other type could reach this table; only rows with a LIVE outbox row of
  -- another type would falsify the claim, and those are what this counts.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = to_regclass('public.rebook_round_transport_transitions')
                AND attname = 'rebook_round_recipient_id' AND attnum > 0 AND NOT attisdropped) THEN

    SELECT count(*) INTO v_pre FROM public.rebook_round_transport_transitions;
    SELECT count(*) INTO v_foreign
      FROM public.rebook_round_transport_transitions t
      JOIN public.notification_outbox o ON o.id = t.outbox_id
     WHERE o.event_type <> 'rebook_member_open_player';

    IF v_foreign > 0 THEN
      RAISE EXCEPTION 'D7 subject model: % pre-existing transition row(s) are not snapshot-member — the backfill default would be ambiguous, refusing',
        v_foreign;
    END IF;
    RAISE NOTICE 'D7 subject model: % pre-existing transition row(s), all snapshot-member', v_pre;

    -- ── THE RESHAPE ───────────────────────────────────────────────────────────────────────
    --
    -- RENAME, not add-and-copy: the rename moves no data and cannot half-succeed, so every existing
    -- value stays bit-for-bit what it was and there is no window in which two columns disagree.
    EXECUTE 'ALTER TABLE public.rebook_round_transport_transitions
               RENAME COLUMN rebook_round_recipient_id TO subject_uuid';

    -- `ADD COLUMN NOT NULL DEFAULT` is metadata-only since PG11 (`attmissingval`); the subsequent
    -- DROP DEFAULT does NOT rewrite the table and does NOT null the pre-existing rows — they keep
    -- being served their missing value. Dropping it matters because from here on a writer must state
    -- the subject domain explicitly: `SAFETY=..._REQUIRE_THE_EXACT_AUTHORIZED_SUBJECT` is defeated by
    -- a column that quietly supplies one.
    EXECUTE 'ALTER TABLE public.rebook_round_transport_transitions
               ADD COLUMN subject_domain text NOT NULL DEFAULT ''snapshot_member''';
    EXECUTE 'ALTER TABLE public.rebook_round_transport_transitions
               ALTER COLUMN subject_domain DROP DEFAULT';
    EXECUTE 'ALTER TABLE public.rebook_round_transport_transitions
               ADD CONSTRAINT chk_rrtt_subject_domain
               CHECK (subject_domain = ANY (public.rebook_round_transport_subject_domains()))';

    -- ── THE LIVE-GRANT KEY ────────────────────────────────────────────────────────────────
    --
    -- Stated honestly: because one outbox row has exactly one subject, adding the domain here does
    -- NOT change which grants collide — its uniqueness contribution is nil. It is added so the index
    -- covers the full triple the consumption paths now match on. The property that actually stops a
    -- snapshot-member grant authorizing a priority-claim write is the consume-side predicate in
    -- `20261203270000`, and that is where the proof for it lives.
    EXECUTE 'ALTER TABLE public.rebook_round_transport_transitions
               DROP CONSTRAINT uq_rrtt_live_transition';
    EXECUTE 'ALTER TABLE public.rebook_round_transport_transitions
               ADD CONSTRAINT uq_rrtt_live_transition UNIQUE NULLS NOT DISTINCT
               (outbox_id, subject_domain, subject_uuid, action, from_transport_state, to_transport_state)';
  ELSE
    RAISE NOTICE 'D7 subject model: transitions already reshaped — skipping';
  END IF;

  -- ══ THE TARGETS ARM ═══════════════════════════════════════════════════════════════════════
  --
  -- `PIN_WIDENING_PROOF=RETAIN_ALL_EXISTING_SNAPSHOT_MEMBER_ARMS_ADD_THE_EXACT_PRIORITY_CLAIM_ARM`.
  -- Every pre-existing arm is reproduced verbatim and one arm is added. The `subject` arm keeps
  -- sourcing `rebook_round_subject_types()`, so the person vocabulary is untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = to_regclass('public.rebook_round_operation_targets')
                    AND conname = 'chk_rrot_kind'
                    AND pg_get_constraintdef(oid) LIKE '%priority_claim%') THEN
    EXECUTE 'ALTER TABLE public.rebook_round_operation_targets DROP CONSTRAINT chk_rrot_kind';
    EXECUTE 'ALTER TABLE public.rebook_round_operation_targets
               ADD CONSTRAINT chk_rrot_kind
               CHECK (target_kind IN (''cycle'',''snapshot_member'',''subject'',''slot'',''priority_claim''))';
    EXECUTE 'ALTER TABLE public.rebook_round_operation_targets DROP CONSTRAINT chk_rrot_domain_matches_kind';
    EXECUTE 'ALTER TABLE public.rebook_round_operation_targets
               ADD CONSTRAINT chk_rrot_domain_matches_kind
               CHECK (
                     (target_kind = ''cycle''           AND target_domain = ''cycle'')
                  OR (target_kind = ''snapshot_member'' AND target_domain = ''snapshot_member'')
                  OR (target_kind = ''slot''            AND target_domain = ''slot'')
                  OR (target_kind = ''priority_claim''  AND target_domain = ''priority_claim'')
                  OR (target_kind = ''subject''         AND target_domain = ANY (public.rebook_round_subject_types()))
               )';
  END IF;

  -- PROVED FROM THE CATALOG, not from the strings just executed: every retained arm is still there
  -- and the new one is exact. A widening that dropped an arm would otherwise read as a success.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_catalog.pg_constraint
   WHERE conrelid = to_regclass('public.rebook_round_operation_targets') AND conname = 'chk_rrot_domain_matches_kind';
  IF v_def IS NULL
     OR position('''cycle''' IN v_def) = 0
     OR position('''snapshot_member''' IN v_def) = 0
     OR position('''slot''' IN v_def) = 0
     OR position('''priority_claim''' IN v_def) = 0
     OR position('rebook_round_subject_types' IN v_def) = 0 THEN
    RAISE EXCEPTION 'D7 subject model: chk_rrot_domain_matches_kind lost an arm (actual: %)', coalesce(v_def, '<missing>');
  END IF;

  -- ══ THE INVITATION SUBJECT ON THE OUTBOX ROW ══════════════════════════════════════════════
  --
  -- NO FOREIGN KEY, deliberately — see the header. Nullable, because member-open rows do not have one.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = to_regclass('public.notification_outbox')
                    AND attname = 'related_slot_priority_claim_id' AND attnum > 0 AND NOT attisdropped) THEN
    EXECUTE 'ALTER TABLE public.notification_outbox ADD COLUMN related_slot_priority_claim_id uuid';
  END IF;

  -- Exclusivity, additively. A row may name a snapshot member or a claim, never both — so a grant
  -- consumption path can never find two candidate subjects on one row and pick the wrong one.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = to_regclass('public.notification_outbox')
                    AND conname = 'chk_notification_outbox_transport_subject_exclusive') THEN
    EXECUTE 'ALTER TABLE public.notification_outbox
               ADD CONSTRAINT chk_notification_outbox_transport_subject_exclusive
               CHECK (num_nonnulls(related_rebook_round_recipient_id, related_slot_priority_claim_id) <= 1) NOT VALID';
    EXECUTE 'ALTER TABLE public.notification_outbox VALIDATE CONSTRAINT chk_notification_outbox_transport_subject_exclusive';
  END IF;

  -- The invitation's shape, mirroring `chk_notification_outbox_rebook_member_open_shape` arm for arm:
  -- a claim, a round, a tenant, EXACTLY ONE recipient identity, and explicitly NO snapshot recipient.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = to_regclass('public.notification_outbox')
                    AND conname = 'chk_notification_outbox_priority_claim_invite_shape') THEN
    EXECUTE 'ALTER TABLE public.notification_outbox
               ADD CONSTRAINT chk_notification_outbox_priority_claim_invite_shape
               CHECK (
                 event_type <> ''rebook_priority_claim_invite''
                 OR (
                       related_slot_priority_claim_id     IS NOT NULL
                   AND related_rebook_round_id            IS NOT NULL
                   AND tenant_academy_profile_id          IS NOT NULL
                   AND related_rebook_round_recipient_id  IS NULL
                   AND num_nonnulls(recipient_guest_player_id, recipient_user_id) = 1
                 )
               ) NOT VALID';
    EXECUTE 'ALTER TABLE public.notification_outbox VALIDATE CONSTRAINT chk_notification_outbox_priority_claim_invite_shape';
  END IF;

  RAISE NOTICE 'D7: one closed transport subject — snapshot_member and priority_claim';
END $d7_subject_model$;
