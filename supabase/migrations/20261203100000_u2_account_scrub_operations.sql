-- U2 Slice B1 — the retain-and-scrub operation ledger (INERT foundation).
--
-- Applying this migration does NOT delete, scrub, detach, backfill or otherwise rewrite an account,
-- Player, membership, booking, invoice, notification or Auth row. It creates ONE new empty table so
-- a later command can honestly coordinate the only ordering that is safe:
--
--   transactional database scrub -> external Auth/asset cleanup -> durable completion
--
-- External cleanup cannot share the PostgreSQL transaction. A leased, retryable state is therefore
-- part of correctness, not job-runner decoration.
--
-- WHY A NEW TABLE RATHER THAN A SECOND LANE IN account_deletion_audit.
--
-- The first draft of this slice versioned the existing audit ledger. It worked, but it inherited a
-- column set built for a different job — subject_email, subject_name, ip_address, user_agent and a
-- free-text failure_reason — and then had to forbid every one of them, row shape by row shape, in a
-- coherence CHECK that spanned two protocols. Three consequences made that the wrong foundation:
--
--   1. PRIVACY. The operation ledger is the record of an ERASURE, and it is not rederivable from
--      anything else: once a scrub has run, no surviving row says which account it erased. A future
--      restore-replay protocol — restore into an outbound-isolated environment, replay every erasure
--      completed after the restore point, reconcile Auth and Storage, and only then reopen the system
--      — needs exactly this evidence to exist, and it cannot be reconstructed after the fact. That is
--      the requirement. Making it durable recovery evidence and making it share a table with the
--      subject's email, name and IP are directly opposed. Split, the new table holds NO DIRECT
--      IDENTIFIER of any kind — see the column list below — so exporting it adds none
--      — it still exports personal data, because those UUIDs stay linkable to a person, and the
--      rows are pseudonymous personal data with every obligation that follows. What the split buys
--      is a smaller blast radius, not an exemption. It also stops account_deletion_audit being
--      pulled into the schema-derived identity/Player family by a person column it never had.
--
--      To be exact about what this migration does and does not deliver: preserving the evidence is
--      NOT the replay protocol, and no such protocol exists yet. Nothing today reads this ledger on
--      restore; nothing today even writes to it. Exporting it means a future protocol will have the
--      inputs it needs. Until that protocol is designed, reviewed and built, a restore can still
--      reinstate an erased account, and the durability of the erasure record outside the ordinary
--      restore point remains an open item for the separate DR slice.
--   2. CORRECTNESS. Sharing started_at and a nullable column set with the legacy lane is what made
--      two permanent-wedge defects reachable (see THE DATABASE OWNS TIME below). A purpose-built
--      table states the same invariants with far less machinery.
--   3. BLAST RADIUS. account_deletion_audit — its schema, its rows, its constraints, its trigger and
--      its two current callers — is untouched by this migration. Nothing that works today can break.
--
-- THE DATABASE OWNS TIME. Every durable timestamp here is stamped by the trigger from one
-- clock_timestamp() captured when the trigger executes. A caller says WHICH milestone happened; it
-- never says WHEN, and any value it supplies for a timestamp is overwritten rather than trusted.
-- That is not tidiness, it closes two reproduced wedges in the draft this replaces:
--
--   * a row inserted with a future started_at could reach NEITHER of its exits, because both were
--     gated on a CHECK comparing the DB-stamped finish against the caller-supplied start. started_at
--     was immutable and the row was append-only, so the operation could never finish — and the
--     one-active-operation index then blocked that subject from EVER being erased again.
--   * a worker whose own clock ran ahead of Postgres (delete-user-data.ts already stamps external
--     work with new Date()) could write auth_deleted_at into the future. Completion required
--     finished_at >= auth_deleted_at with finished_at forced to wall-clock now, the marker was
--     write-once, and release-and-retry preserved it — so the erasure was unfinishable until real
--     time caught up. A one-hour skew meant an hour during which the account could not be erased and
--     no replacement operation could be created.
--
-- Because the state machine below can only reach a milestone by passing through the ones before it,
-- ordering is guaranteed STRUCTURALLY. There is deliberately no CHECK comparing two timestamps: such
-- a CHECK cannot make the order more true, and it can make a row unfinishable. For a privacy-erasure
-- operation, evidence that is a few milliseconds out of order is harmless; an operation that can
-- never complete is not.
--
-- lease_expires_at, next_attempt_at and external_attempt_count are DB-owned for the same reason: a
-- caller cannot grant itself an eternal lease, retry with no backoff, or skip an attempt.

CREATE TABLE public.account_scrub_operations (
  -- `id` is a single uuid primary key because the logical backup keyset-walks on exactly that;
  -- scripts/db/backup-coverage.mjs refuses a backed-up table shaped any other way.
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The idempotency key, generated by the caller before the first attempt and reused verbatim by
  -- every retry of the SAME logical command. Never derived from an email, a phone number or a name.
  command_id               uuid NOT NULL UNIQUE,

  -- FK-free on purpose, exactly as account_deletion_audit is: this row must outlive the auth user it
  -- names and the sources the canonical Player was built from. Evidence that cascades is not
  -- evidence, and the whole point of retain-and-scrub is that persons.id SURVIVES.
  subject_user_id          uuid NOT NULL,
  actor_user_id            uuid NOT NULL,
  self_service             boolean NOT NULL,

  -- The canonical persons.id the scrub RETAINED. Bound exactly once, by the transaction that
  -- actually retained it, because that is the only moment the value is authoritative. NULL before
  -- then, required and immutable after.
  subject_person_id        uuid,

  state                    text NOT NULL DEFAULT 'started',

  started_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  database_scrubbed_at     timestamptz,
  auth_deleted_at          timestamptz,
  public_assets_deleted_at timestamptz,
  finished_at              timestamptz,

  -- bigint, not integer. Post-scrub work is retryable for ever by design, so this counter has no
  -- POLICY ceiling; a column type gives it an arithmetic one, and overflowing that raises on every
  -- subsequent claim — leaving a row that cannot advance, cannot fail, cannot be deleted, and whose
  -- subject the one-live-operation index then blocks for good. bigint does not abolish the ceiling,
  -- it moves it out of reach: 2^63 attempts at the five-minute lease floor is on the order of 10^13
  -- years, against 2^31 which a determined loop could be argued toward. A parked state and an alert
  -- threshold for an operation retrying for days still belong to the worker slice.
  external_attempt_count   bigint NOT NULL DEFAULT 0,
  last_attempt_at          timestamptz,
  next_attempt_at          timestamptz,
  lease_token              uuid,
  lease_expires_at         timestamptz,

  -- A controlled machine category. Raw provider or database messages are transient log material and
  -- never durable erasure evidence: they routinely quote the address or name being erased.
  last_error_code          text,

  CONSTRAINT account_scrub_operations_self_service_check
    CHECK (self_service = (actor_user_id = subject_user_id)),
  CONSTRAINT account_scrub_operations_attempts_check
    CHECK (external_attempt_count >= 0),
  CONSTRAINT account_scrub_operations_error_code_check
    CHECK (
      last_error_code IS NULL OR last_error_code IN (
        -- terminal, and only before the scrub commits
        'database_terminal',
        'unsupported_account',
        -- retryable, and only after it does
        'auth_retryable',
        'auth_ambiguous',
        'asset_retryable',
        'external_ambiguous',
        'unexpected_internal'
      )
    ),

  -- The legal shapes of a row, per state. Structural only — no two timestamps are compared.
  CONSTRAINT account_scrub_operations_state_shape_check CHECK (
    (
      state = 'started'
      AND subject_person_id IS NULL
      AND database_scrubbed_at IS NULL
      AND auth_deleted_at IS NULL
      AND public_assets_deleted_at IS NULL
      AND finished_at IS NULL
      AND external_attempt_count = 0
      AND last_attempt_at IS NULL
      AND next_attempt_at IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND last_error_code IS NULL
    )
    OR (
      -- Scrub committed; external work is pending or backing off. No lease is held here.
      state = 'database_scrubbed'
      AND subject_person_id IS NOT NULL
      AND database_scrubbed_at IS NOT NULL
      AND finished_at IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND (
        (external_attempt_count = 0
         AND last_attempt_at IS NULL
         AND next_attempt_at IS NULL
         AND last_error_code IS NULL
         -- An outcome can only be recorded while holding a lease, and holding one means at least
         -- one attempt. Zero attempts and a recorded outcome is not a state the graph can produce.
         AND auth_deleted_at IS NULL
         AND public_assets_deleted_at IS NULL)
        OR
        (external_attempt_count > 0
         AND last_attempt_at IS NOT NULL
         AND next_attempt_at IS NOT NULL
         -- IS NOT NULL first, and not decoration: `NULL IN (...)` evaluates to NULL, and a CHECK
         -- accepts NULL. Without this a backing-off row could carry no reason at all.
         AND last_error_code IS NOT NULL
         AND last_error_code IN (
           'auth_retryable', 'auth_ambiguous', 'asset_retryable',
           'external_ambiguous', 'unexpected_internal')
         -- a reason cannot contradict the outcome it is attached to
         AND (last_error_code NOT IN ('auth_retryable', 'auth_ambiguous') OR auth_deleted_at IS NULL)
         AND (last_error_code <> 'asset_retryable' OR public_assets_deleted_at IS NULL))
      )
    )
    OR (
      -- Exactly one worker holds this row, and the lease says until when.
      state = 'external_cleanup_in_progress'
      AND subject_person_id IS NOT NULL
      AND database_scrubbed_at IS NOT NULL
      AND finished_at IS NULL
      AND external_attempt_count > 0
      AND last_attempt_at IS NOT NULL
      AND next_attempt_at IS NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      state = 'completed'
      AND subject_person_id IS NOT NULL
      AND database_scrubbed_at IS NOT NULL
      AND auth_deleted_at IS NOT NULL
      AND public_assets_deleted_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND external_attempt_count > 0
      AND last_attempt_at IS NOT NULL
      AND next_attempt_at IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND last_error_code IS NULL
    )
    OR (
      -- Terminal failure is legal ONLY before the scrub commits. Once database state has been
      -- destroyed, giving up would strand the account half-erased, so post-scrub failure is always
      -- retryable and there is no transition out of this table to a terminal failed row.
      state = 'failed'
      AND subject_person_id IS NULL
      AND database_scrubbed_at IS NULL
      AND auth_deleted_at IS NULL
      AND public_assets_deleted_at IS NULL
      AND finished_at IS NOT NULL
      AND external_attempt_count = 0
      AND last_attempt_at IS NULL
      AND next_attempt_at IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      -- IS NOT NULL first: see the retry arm above. A terminal failure with no reason would
      -- otherwise satisfy this arm, and a refusal nobody can explain is not evidence.
      AND last_error_code IS NOT NULL
      AND last_error_code IN ('database_terminal', 'unsupported_account')
    )
  )
);

COMMENT ON TABLE public.account_scrub_operations IS
  'Append-only ledger of retain-and-scrub account-erasure operations (U2 OD-08). Direct-identifier-minimized by contract: it holds UUIDs, one boolean, one attempt counter, a state, a controlled error code and database-stamped timestamps, and NO DIRECT IDENTIFIER — no email, name, phone, IP, user-agent or raw provider error ever enters it. Its UUIDs remain linkable to a person, so the table is PSEUDONYMOUS PERSONAL DATA, not anonymous data, and every access, export and retention rule that follows from that applies to it. It is included in the logical export because it is durable, non-rederivable evidence: nothing else records which account an erasure erased, and a future restore-replay protocol will need it. Including it does not by itself prevent a restore from reinstating an erased account — no replay protocol exists yet, nothing reads this ledger on restore, and in this release nothing writes to it either.';

COMMENT ON COLUMN public.account_scrub_operations.command_id IS
  'Stable caller-generated UUID idempotency key. Every retry of the same logical command reuses it, so a lost response can never mint a second erasure. Never derived from PII.';
COMMENT ON COLUMN public.account_scrub_operations.subject_person_id IS
  'The canonical persons.id the scrub RETAINED. Bound exactly once, from NULL, by the transaction that commits the database scrub; required and immutable thereafter. FK-free so the evidence outlives every source row and drives no cascade.';
COMMENT ON COLUMN public.account_scrub_operations.started_at IS
  'When this erasure operation was opened, stamped by the guard trigger from clock_timestamp() on INSERT; a value supplied by the caller is discarded. Two reasons. It is evidence, and evidence of when an erasure began should come from the machine that recorded it rather than from whichever process asked. And an earlier draft of this table compared caller time against database time in its CHECK constraints, which let a future start produce a row that could satisfy no exit at all — that comparison is gone, and so is the caller time that made it dangerous.';
COMMENT ON COLUMN public.account_scrub_operations.last_error_code IS
  'Why the last attempt did not succeed, as one value from a controlled vocabulary fixed by account_scrub_operations_error_code_check. It is deliberately coarse, and free text is rejected rather than truncated: a provider or PostgreSQL message can quote the address, name or row being erased, so the detail belongs in transient redacted logs and never in durable erasure evidence. Codes before the scrub commits are terminal; codes after it are retryable.';
COMMENT ON COLUMN public.account_scrub_operations.lease_expires_at IS
  'Database-stamped fencing deadline. A worker cannot choose or extend it; when it passes, another worker may reclaim the row with a fresh token and the previous holder can no longer write.';

-- ── indexes ────────────────────────────────────────────────────────────────────────────────────
-- One live erasure per account. A finished operation does not block a later, genuinely new one.
CREATE UNIQUE INDEX account_scrub_operations_one_active_subject
  ON public.account_scrub_operations (subject_user_id)
  WHERE state NOT IN ('completed', 'failed');

-- Worker/reconciler entrypoints. PostgreSQL cannot use two independent range columns behind one
-- btree prefix, so ready work and expired leases get separate partial indexes. The COALESCE makes a
-- first attempt ready at database_scrubbed_at and a retry ready at next_attempt_at.
-- Nothing consumes either until the later RPC/worker slice.
CREATE INDEX account_scrub_operations_ready_external
  ON public.account_scrub_operations (
    (COALESCE(next_attempt_at, database_scrubbed_at)),
    started_at,
    id
  )
  WHERE state = 'database_scrubbed';

CREATE INDEX account_scrub_operations_expired_lease
  ON public.account_scrub_operations (lease_expires_at, started_at, id)
  WHERE state = 'external_cleanup_in_progress';

-- ── the guard ──────────────────────────────────────────────────────────────────────────────────
-- OWNER-EFFECTIVE, so a future SECURITY DEFINER command cannot bypass it by accident. It pins the
-- transition graph and owns every timestamp. It is NOT by itself an activated concurrency boundary:
-- the later claim/progress/release/finalize RPCs must still predicate their UPDATEs on the operation
-- id, the caller's current lease_token and an unexpired lease, so a stale holder's statement matches
-- zero rows rather than arriving here at all.
CREATE OR REPLACE FUNCTION public.account_scrub_operations_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  -- Transaction time is unsafe for leases: a transaction can begin before expiry, wait on a lock,
  -- and then execute after expiry while now() still reports its old start. One wall-clock reading,
  -- taken here, is used for every decision and every stamp in this invocation.
  v_wall_now  timestamptz := clock_timestamp();
  -- The fencing window a claim gets. Fixed by the protocol, not by the caller.
  c_lease     constant interval := interval '5 minutes';
  v_advanced  boolean := false;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'account_scrub_operations is append-only: erasing the record of an erasure is the one thing it exists to prevent';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'started' THEN
      RAISE EXCEPTION 'account_scrub_operations: an operation must begin at started';
    END IF;
    -- The database owns time. Whatever the caller sent is discarded, so no clock but this one can
    -- place a row outside the window its own exits need.
    NEW.started_at := v_wall_now;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.self_service IS DISTINCT FROM OLD.self_service
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.database_scrubbed_at IS DISTINCT FROM OLD.database_scrubbed_at
     OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
     OR (
       NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id
       AND NOT (
         OLD.state = 'started'
         AND NEW.state = 'database_scrubbed'
         AND OLD.subject_person_id IS NULL
         AND NEW.subject_person_id IS NOT NULL
       )
     ) THEN
    RAISE EXCEPTION 'account_scrub_operations: operation identity, its committed milestones and its start are immutable';
  END IF;

  -- Belt and braces for the columns this trigger has not been taught about. A later migration that
  -- adds one gets a refusal here rather than a silent hole in the immutability contract.
  IF (to_jsonb(NEW) - ARRAY[
        'state', 'subject_person_id', 'database_scrubbed_at', 'auth_deleted_at',
        'public_assets_deleted_at', 'finished_at', 'external_attempt_count', 'last_attempt_at',
        'next_attempt_at', 'lease_token', 'lease_expires_at', 'last_error_code'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state', 'subject_person_id', 'database_scrubbed_at', 'auth_deleted_at',
        'public_assets_deleted_at', 'finished_at', 'external_attempt_count', 'last_attempt_at',
        'next_attempt_at', 'lease_token', 'lease_expires_at', 'last_error_code'
      ]) THEN
    RAISE EXCEPTION 'account_scrub_operations: only lifecycle fields may change';
  END IF;

  -- External outcomes are recorded ONCE, by the database, and never rewritten. A caller marks a
  -- milestone by setting the column to any non-NULL value; the value itself is discarded.
  IF OLD.state = 'external_cleanup_in_progress' THEN
    IF NEW.auth_deleted_at IS DISTINCT FROM OLD.auth_deleted_at THEN
      IF OLD.auth_deleted_at IS NOT NULL OR NEW.auth_deleted_at IS NULL THEN
        RAISE EXCEPTION 'account_scrub_operations: an external outcome is recorded once and never rewritten';
      END IF;
      NEW.auth_deleted_at := v_wall_now;
      v_advanced := true;
    END IF;
    IF NEW.public_assets_deleted_at IS DISTINCT FROM OLD.public_assets_deleted_at THEN
      IF OLD.public_assets_deleted_at IS NOT NULL OR NEW.public_assets_deleted_at IS NULL THEN
        RAISE EXCEPTION 'account_scrub_operations: an external outcome is recorded once and never rewritten';
      END IF;
      NEW.public_assets_deleted_at := v_wall_now;
      v_advanced := true;
    END IF;
  ELSIF NEW.auth_deleted_at IS DISTINCT FROM OLD.auth_deleted_at
     OR NEW.public_assets_deleted_at IS DISTINCT FROM OLD.public_assets_deleted_at THEN
    RAISE EXCEPTION 'account_scrub_operations: external outcomes may only be recorded while holding the lease';
  END IF;

  -- ── started -> database_scrubbed ─────────────────────────────────────────────────────────────
  IF OLD.state = 'started' AND NEW.state = 'database_scrubbed' THEN
    IF NEW.subject_person_id IS NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: the scrub must record the canonical person it retained';
    END IF;
    IF NEW.external_attempt_count <> 0
       OR NEW.last_attempt_at IS NOT NULL
       OR NEW.next_attempt_at IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: the database scrub cannot forge external cleanup state';
    END IF;
    NEW.database_scrubbed_at := v_wall_now;
    RETURN NEW;
  END IF;

  -- ── started -> failed (the only terminal failure) ────────────────────────────────────────────
  IF OLD.state = 'started' AND NEW.state = 'failed' THEN
    IF NEW.last_error_code IS NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: a terminal failure must say why, as a controlled code';
    END IF;
    IF NEW.external_attempt_count <> 0
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: a terminal failure is allowed only before the database scrub';
    END IF;
    NEW.finished_at := v_wall_now;
    RETURN NEW;
  END IF;

  -- ── claim: database_scrubbed -> external_cleanup_in_progress ─────────────────────────────────
  IF OLD.state = 'database_scrubbed' AND NEW.state = 'external_cleanup_in_progress' THEN
    IF OLD.next_attempt_at IS NOT NULL AND OLD.next_attempt_at > v_wall_now THEN
      RAISE EXCEPTION 'account_scrub_operations: this operation is backing off until %', OLD.next_attempt_at;
    END IF;
    IF NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'account_scrub_operations: a claim requires one fresh lease token';
    END IF;
    NEW.external_attempt_count := OLD.external_attempt_count + 1;
    NEW.last_attempt_at        := v_wall_now;
    NEW.lease_expires_at       := v_wall_now + c_lease;
    NEW.next_attempt_at        := NULL;
    NEW.last_error_code        := NULL;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'external_cleanup_in_progress' THEN
    RAISE EXCEPTION 'account_scrub_operations: invalid transition % -> %', OLD.state, NEW.state;
  END IF;

  -- ── reclaim: an EXPIRED lease, taken over with a fresh token ─────────────────────────────────
  IF NEW.state = 'external_cleanup_in_progress'
     AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    IF OLD.lease_expires_at > v_wall_now THEN
      RAISE EXCEPTION 'account_scrub_operations: only an expired lease may be reclaimed';
    END IF;
    IF NEW.lease_token IS NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: a reclaim requires one fresh lease token';
    END IF;
    IF v_advanced THEN
      RAISE EXCEPTION 'account_scrub_operations: a reclaim records no external outcome of its own';
    END IF;
    NEW.external_attempt_count := OLD.external_attempt_count + 1;
    NEW.last_attempt_at        := v_wall_now;
    NEW.lease_expires_at       := v_wall_now + c_lease;
    NEW.next_attempt_at        := NULL;
    NEW.last_error_code        := NULL;
    RETURN NEW;
  END IF;

  -- Everything below is the CURRENT holder acting, so its lease must still be valid. An expired
  -- holder writes nothing: its work is another worker's to redo under a new token.
  IF OLD.lease_expires_at <= v_wall_now THEN
    RAISE EXCEPTION 'account_scrub_operations: this lease expired at %; it may only be reclaimed', OLD.lease_expires_at;
  END IF;

  -- ── progress: record an external outcome, keep the lease ─────────────────────────────────────
  IF NEW.state = 'external_cleanup_in_progress' THEN
    IF NOT v_advanced THEN
      RAISE EXCEPTION 'account_scrub_operations: an in-place update must record an external outcome';
    END IF;
    IF NEW.external_attempt_count <> OLD.external_attempt_count
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at
       OR NEW.next_attempt_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: a lease cannot be extended, renumbered or rescheduled in place';
    END IF;
    RETURN NEW;
  END IF;

  -- ── release: external_cleanup_in_progress -> database_scrubbed, with a backoff ───────────────
  IF NEW.state = 'database_scrubbed' THEN
    IF v_advanced THEN
      RAISE EXCEPTION 'account_scrub_operations: record an external outcome before releasing, not while releasing';
    END IF;
    IF NEW.last_error_code IS NULL
       OR NEW.last_error_code NOT IN (
         'auth_retryable', 'auth_ambiguous', 'asset_retryable',
         'external_ambiguous', 'unexpected_internal') THEN
      RAISE EXCEPTION 'account_scrub_operations: releasing a lease requires a retryable, controlled error code';
    END IF;
    IF NEW.external_attempt_count <> OLD.external_attempt_count
       OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at THEN
      RAISE EXCEPTION 'account_scrub_operations: a release does not renumber the attempt it is ending';
    END IF;
    -- The schedule is the protocol's, not the caller's: exponential, capped, and always in the
    -- future, so a released operation can neither hot-spin nor be parked forever by a bad value.
    NEW.next_attempt_at  := v_wall_now
      + least(interval '30 seconds' * power(2, least(OLD.external_attempt_count, 10)), interval '6 hours');
    NEW.lease_token      := NULL;
    NEW.lease_expires_at := NULL;
    RETURN NEW;
  END IF;

  -- ── finalize: external_cleanup_in_progress -> completed ──────────────────────────────────────
  IF NEW.state = 'completed' THEN
    IF NEW.auth_deleted_at IS NULL OR NEW.public_assets_deleted_at IS NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: completion requires every external outcome to be recorded';
    END IF;
    IF NEW.external_attempt_count <> OLD.external_attempt_count
       OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at
       OR NEW.next_attempt_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'account_scrub_operations: completion does not renumber or reschedule the attempt it ends';
    END IF;
    NEW.lease_token      := NULL;
    NEW.lease_expires_at := NULL;
    NEW.finished_at      := v_wall_now;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'account_scrub_operations: invalid transition % -> %', OLD.state, NEW.state;
END $$;

CREATE TRIGGER trg_account_scrub_operations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_scrub_operations
  FOR EACH ROW EXECUTE FUNCTION public.account_scrub_operations_guard();
CREATE TRIGGER trg_account_scrub_operations_no_truncate
  BEFORE TRUNCATE ON public.account_scrub_operations
  FOR EACH STATEMENT EXECUTE FUNCTION public.account_scrub_operations_guard();

-- ── access: NO client role may touch this table directly ───────────────────────────────────────
-- Not "mirroring account_deletion_audit" — deliberately stricter than it, because this ledger is
-- reached only through code that has not been written yet, so the safe default costs nothing now and
-- would be a migration and an argument later.
--
-- service_role is revoked along with everyone else. That is the point of the boundary. A broad
-- INSERT/UPDATE grant would let any edge function holding the service key write any transition on
-- any row, and the guard trigger cannot help with that: it validates the shape of a transition, not
-- whether the caller was entitled to make it. Lease fencing has the same hole — an UPDATE that
-- forgets `AND lease_token = $token` is a valid transition to the trigger and a stolen lease in
-- practice. Withholding the privilege removes the class instead of asking every future caller to
-- remember.
--
-- The admin SELECT policy that stood here is gone too. It could never fire: a policy filters rows a
-- role may already read, and `authenticated` has no SELECT privilege on this table, so the policy was
-- decoration that read as access control — the worst kind of ACL, because a reviewer counts it.
--
-- RLS stays ON with zero policies, which is deny-all. It is the backstop for the day someone grants
-- a role SELECT without reading this comment.
--
-- HOW ACCESS ARRIVES LATER, when it is needed: narrow SECURITY DEFINER RPCs, one per transition
-- (open, scrub, claim, progress, release, finalize) plus a bounded operator read. Each takes the
-- operation id and — after the scrub — the caller's current lease token, and predicates its UPDATE
-- on both, so a stale holder's statement matches zero rows before the trigger is ever consulted.
-- Each gets EXECUTE granted to exactly the role that needs it, and nothing gets table privileges.
-- **None of those RPCs is in B1.** Until they exist, this table is reachable only by its owner and
-- by the already-reviewed SECURITY DEFINER export path, which is precisely the intended state for a
-- table with no writer.
ALTER TABLE public.account_scrub_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_scrub_operations FROM PUBLIC, anon, authenticated, service_role;

-- ── backup coverage ────────────────────────────────────────────────────────────────────────────
-- This ledger joins the logical export because it is non-rederivable: restore a database to a point
-- before an erasure and nothing in the restored state says the account was subsequently erased, and
-- no later query can work it out. Exporting it PRESERVES THE EVIDENCE a future restore-replay
-- protocol will need; it is not that protocol and does not stand in for one. Adding it introduces NO
-- DIRECT IDENTIFIER: the columns are UUIDs, one boolean, one attempt counter, a state, a controlled
-- code and timestamps. It does add personal data — those UUIDs remain linkable to a person, so the
-- exported rows are pseudonymous personal data and inherit every access, encryption and retention
-- control the export carries.
--
-- Revoking service_role above does not break this. backup_export_table/backup_export_group are
-- SECURITY DEFINER and run as the owner, so they read the table on the backup's behalf without the
-- backup's role holding any privilege on it — the same path academy_player_memberships and the two
-- manifest tables already take, and the reason that path was built. backup-coverage.mjs proves it by
-- running the real export as service_role rather than by asserting the grant shape.
--
-- The whole allow-list is redefined rather than appended to, so it stays one reviewable literal;
-- scripts/db/backup-coverage.mjs proves it and TABLES_TO_BACKUP cannot drift apart.
CREATE OR REPLACE FUNCTION public.backup_export_tables()
RETURNS TABLE (relname text)
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM (VALUES
    ('academy_managers'), ('academy_player_locations'), ('academy_player_memberships'),
    ('academy_player_metadata'), ('academy_player_tags'), ('academy_profiles'),
    ('academy_trainers'), ('account_scrub_operations'), ('availability_slots'), ('bookings'),
    ('club_managers'), ('club_profiles'), ('guest_players'), ('intake_requests'), ('invoices'),
    ('locations'), ('membership_backfill_items'), ('membership_backfill_runs'),
    ('notification_contacts'), ('person_links'), ('person_merge_review'), ('persons'),
    ('player_create_commands'),
    ('profiles'), ('proposed_assignments'), ('session_player_notes'),
    ('slot_priority_claims'), ('trainer_profiles'), ('user_roles')
  ) AS t(relname);
$$;

COMMENT ON FUNCTION public.backup_export_tables() IS
  'The tables the backup may export, as an immutable allow-list. Mirrors TABLES_TO_BACKUP in supabase/functions/backup-database/index.ts; scripts/db/backup-coverage.mjs proves the two cannot drift. U2 added player_create_commands (the create receipt that stops a replay minting a duplicate Player) and account_scrub_operations (the erasure record, preserved as evidence for a future restore-replay protocol — the protocol itself does not exist yet). Every exported table holds personal data, pseudonymous at least: this export is a SCOPED recovery snapshot, not complete disaster recovery, and full-database recovery including all required PII is Supabase physical backup/PITR.';
